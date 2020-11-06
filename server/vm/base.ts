import config from '../config';
import { Room } from '../room';
import Redis from 'ioredis';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { redisCount } from '../utils/redis';
import { getStartOfDay } from '../utils/time';

const releaseInterval = 5 * 60 * 1000;

export abstract class VMManager {
  public vmBufferSize = 0;
  protected tag = config.VBROWSER_TAG || 'vbrowser';
  protected isLarge = false;
  private redis = new Redis(config.REDIS_URL);
  private redis2 = new Redis(config.REDIS_URL);
  private redis3 = new Redis(config.REDIS_URL);
  private getFixedSize = () =>
    this.isLarge
      ? Number(config.VM_POOL_FIXED_SIZE_LARGE)
      : Number(config.VM_POOL_FIXED_SIZE);

  constructor(
    rooms: Map<string, Room>,
    vmBufferSize?: number,
    large?: boolean
  ) {
    if (vmBufferSize !== undefined) {
      this.vmBufferSize = vmBufferSize;
    } else {
      if (large) {
        this.vmBufferSize = Number(config.VBROWSER_VM_BUFFER_LARGE) || 0;
      } else {
        this.vmBufferSize = Number(config.VBROWSER_VM_BUFFER) || 0;
      }
    }
    if (large) {
      this.tag += 'Large';
      this.isLarge = true;
    }

    const release = async () => {
      // Reset VMs in rooms that are:
      // older than the session limit
      // assigned to a room with no users
      const roomArr = Array.from(rooms.values());
      for (let i = 0; i < roomArr.length; i++) {
        const room = roomArr[i];
        if (
          room.vBrowser &&
          room.vBrowser.assignTime &&
          (!room.vBrowser.provider ||
            room.vBrowser.provider === this.getRedisQueueKey())
        ) {
          const maxTime = room.vBrowser.large
            ? 12 * 60 * 60 * 1000
            : 3 * 60 * 60 * 1000;
          const elapsed = Number(new Date()) - room.vBrowser.assignTime;
          const isTimedOut = elapsed > maxTime;
          const isAlmostTimedOut = elapsed > maxTime - releaseInterval;
          const isRoomEmpty = room.roster.length === 0;
          if (isTimedOut || isRoomEmpty) {
            console.log('[RELEASE] VM in room:', room.roomId);
            room.stopVBrowser();
            if (isTimedOut) {
              room.addChatMessage(undefined, {
                id: '',
                system: true,
                cmd: 'vBrowserTimeout',
                msg: '',
              });
              redisCount('vBrowserTerminateTimeout');
            } else if (isRoomEmpty) {
              redisCount('vBrowserTerminateEmpty');
            }
          } else if (isAlmostTimedOut) {
            room.addChatMessage(undefined, {
              id: '',
              system: true,
              cmd: 'vBrowserAlmostTimeout',
              msg: '',
            });
          }
        }
      }
    };
    const renew = async () => {
      const roomArr = Array.from(rooms.values());
      for (let i = 0; i < roomArr.length; i++) {
        const room = roomArr[i];
        if (
          room.vBrowser &&
          room.vBrowser.id &&
          (!room.vBrowser.provider ||
            room.vBrowser.provider === this.getRedisQueueKey())
        ) {
          console.log('[RENEW] VM in room:', room.roomId, room.vBrowser.id);
          // Renew the lock on the VM
          await this.redis.expire('vbrowser:' + room.vBrowser.id, 300);

          const expireTime = getStartOfDay() / 1000 + 86400;
          if (room.vBrowser.creatorClientID) {
            await this.redis.zincrby(
              'vBrowserClientIDMinutes',
              1,
              room.vBrowser.creatorClientID
            );
            await this.redis.expireat('vBrowserClientIDMinutes', expireTime);
          }
          if (room.vBrowser.creatorUID) {
            await this.redis.zincrby(
              'vBrowserUIDMinutes',
              1,
              room.vBrowser.creatorUID
            );
            await this.redis.expireat('vBrowserUIDMinutes', expireTime);
          }
        }
      }
    };
    setInterval(this.resizeVMGroupIncr, 10 * 1000);
    setInterval(this.resizeVMGroupDecr, 3 * 60 * 1000);
    setInterval(this.cleanupVMGroup, 3 * 60 * 1000);
    setInterval(renew, 60 * 1000);
    setInterval(release, releaseInterval);
    setTimeout(this.checkStaging, 100); // Add some delay to make sure the object is constructed first
  }

  public getRedisQueueKey = () => {
    return this.redisQueueKey + (this.isLarge ? 'Large' : '');
  };

  public getRedisStagingKey = () => {
    return this.redisStagingKey + (this.isLarge ? 'Large' : '');
  };

  public assignVM = async (): Promise<AssignedVM> => {
    const assignStart = Number(new Date());
    let selected = null;
    while (!selected) {
      const availableCount = await this.redis.llen(this.getRedisQueueKey());
      const stagingCount = await this.redis.llen(this.getRedisStagingKey());
      const fixedSize = this.getFixedSize();
      if (availableCount + stagingCount === 0 && !fixedSize) {
        await this.startVMWrapper();
      }
      let resp = await this.redis2.brpop(this.getRedisQueueKey(), 0);
      const id = resp[1];
      console.log('[ASSIGN]', id);
      const lock = await this.redis.set('vbrowser:' + id, '1', 'NX', 'EX', 300);
      if (!lock) {
        console.log('failed to acquire lock on VM:', id);
        continue;
      }
      let candidate = await this.getVM(id);
      selected = candidate;
    }
    const assignEnd = Number(new Date());
    const assignElapsed = assignEnd - assignStart;
    await this.redis.lpush('vBrowserStartMS', assignElapsed);
    await this.redis.ltrim('vBrowserStartMS', 0, 99);
    console.log('[ASSIGN]', selected.id, assignElapsed + 'ms');
    const retVal = { ...selected, assignTime: Number(new Date()) };
    return retVal;
  };

  public resetVM = async (id: string): Promise<void> => {
    console.log('[RESET]', id);
    // We can attempt to reuse the instance which is more efficient if users tend to use them for a short time
    // Otherwise terminating them is simpler but more expensive since they're billed for an hour
    await this.rebootVM(id);
    // Delete any locks
    await this.redis.del('vbrowser:' + id);
    // We wait to give the VM time to shut down (if it's restarting)
    await new Promise((resolve) => setTimeout(resolve, 3000));
    // Add the VM back to the pool
    await this.redis.lpush(this.getRedisStagingKey(), id);
  };

  protected resizeVMGroupIncr = async () => {
    const maxAvailable = this.vmBufferSize;
    const availableCount = await this.redis.llen(this.getRedisQueueKey());
    const stagingCount = await this.redis.llen(this.getRedisStagingKey());
    let launch = false;
    const fixedSize = this.getFixedSize();
    if (fixedSize) {
      const listVMs = await this.listVMs();
      launch = listVMs.length + stagingCount < fixedSize;
    } else {
      launch = availableCount + stagingCount < maxAvailable;
    }
    if (launch) {
      console.log(
        '[RESIZE-LAUNCH]',
        'desired:',
        maxAvailable,
        'available:',
        availableCount,
        'staging:',
        stagingCount
      );
      this.startVMWrapper();
    }
  };

  protected resizeVMGroupDecr = async () => {
    let unlaunch = false;
    const fixedSize = this.getFixedSize();
    const allVMs = await this.listVMs();
    if (fixedSize) {
      unlaunch = allVMs.length > fixedSize;
    } else {
      const maxAvailable = this.vmBufferSize;
      const availableCount = await this.redis.llen(this.getRedisQueueKey());
      unlaunch = availableCount > maxAvailable;
    }
    if (unlaunch) {
      const now = Date.now();
      let sortedVMs = allVMs.sort(
        (a, b) => -a.creation_date?.localeCompare(b.creation_date)
      );
      sortedVMs = sortedVMs.filter(
        (vm) => now - Number(new Date(vm.creation_date)) > 45 * 60 * 1000
      );
      const id = sortedVMs[0]?.id;
      if (id) {
        console.log('[RESIZE-UNLAUNCH]', id);
        await this.redis.lrem(this.getRedisQueueKey(), 1, id);
        await this.terminateVMWrapper(id);
      }
    }
  };

  protected cleanupVMGroup = async () => {
    // Clean up hanging VMs
    // It's possible we created a VM but lost track of it in redis
    // Take the list of VMs from API, subtract VMs that have a lock in redis or are in the available or staging pool, delete the rest
    const allVMs = await this.listVMs();
    // TODO locks could collide if multiple cloud providers use the same IDs
    const usedKeys = (await this.redis.keys('vbrowser:*')).map((key) =>
      key.slice('vbrowser:'.length)
    );
    const availableKeys = await this.redis.lrange(
      this.getRedisQueueKey(),
      0,
      -1
    );
    const stagingKeys = await this.redis.lrange(
      this.getRedisStagingKey(),
      0,
      -1
    );
    const dontDelete = new Set([...usedKeys, ...availableKeys, ...stagingKeys]);
    // console.log(allVMs, dontDelete);
    for (let i = 0; i < allVMs.length; i++) {
      const server = allVMs[i];
      if (!dontDelete.has(server.id)) {
        // this.terminateVMWrapper(server.id);
        this.resetVM(server.id);
      }
    }
  };

  protected checkStaging = async () => {
    while (true) {
      // Loop through staging list and check if VM is ready
      const id = await this.redis3.brpoplpush(
        this.getRedisStagingKey(),
        this.getRedisStagingKey(),
        0
      );
      let ready = false;
      let candidate = undefined;
      try {
        candidate = await this.getVM(id);
        ready = await this.checkVMReady(candidate.host);
      } catch (e) {
        console.log('[CHECKSTAGING-ERROR]', id, e?.response?.status);
      }
      const retryCount = await this.redis.incr(
        this.getRedisStagingKey() + ':' + id
      );
      if (retryCount % 20 === 0) {
        this.powerOn(id);
      }
      if (ready) {
        console.log('[CHECKSTAGING] ready:', id, candidate?.host, retryCount);
        // If it is, move it to available list
        await this.redis
          .multi()
          .lrem(this.getRedisStagingKey(), 1, id)
          .lpush(this.getRedisQueueKey(), id)
          .del(this.getRedisStagingKey() + ':' + id)
          .exec();
      } else {
        console.log(
          '[CHECKSTAGING] not ready:',
          id,
          candidate?.host,
          retryCount
        );
        if (retryCount > 600) {
          console.log('[CHECKSTAGING] giving up:', id);
          await this.redis.del(this.getRedisStagingKey() + ':' + id);
          // this.resetVM(id);
          this.terminateVMWrapper(id);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };

  protected checkVMReady = async (host: string) => {
    const url = 'https://' + host + '/healthz';
    try {
      const response4 = await axios({
        method: 'GET',
        url,
        timeout: 1000,
      });
    } catch (e) {
      return false;
    }
    return true;
  };

  protected startVMWrapper = async () => {
    // generate credentials and boot a VM
    const password = uuidv4();
    const id = await this.startVM(password);
    await this.redis.lpush(this.getRedisStagingKey(), id);
    redisCount('vBrowserLaunches');
    return id;
  };

  protected terminateVMWrapper = async (id: string) => {
    console.log('[TERMINATE]', id);
    // Remove from lists, if it exists
    await this.redis.lrem(this.getRedisQueueKey(), 1, id);
    await this.redis.lrem(this.getRedisStagingKey(), 1, id);
    // Get the VM data to calculate lifetime, if we fail do the terminate anyway
    const lifetime = await this.terminateVMMetrics(id);
    await this.terminateVM(id);
    if (lifetime) {
      await this.redis.lpush('vBrowserVMLifetime', lifetime);
      await this.redis.ltrim('vBrowserVMLifetime', 0, 49);
    }
  };

  protected terminateVMMetrics = async (id: string) => {
    try {
      const vm = await this.getVM(id);
      const lifetime = Number(new Date()) - Number(new Date(vm.creation_date));
      return lifetime;
    } catch (e) {
      console.warn(e);
    }
    return 0;
  };

  protected abstract redisQueueKey: string;
  protected abstract redisStagingKey: string;
  protected abstract size: string;
  protected abstract largeSize: string;
  protected abstract startVM: (name: string) => Promise<string>;
  protected abstract rebootVM: (id: string) => Promise<void>;
  protected abstract terminateVM: (id: string) => Promise<void>;
  protected abstract getVM: (id: string) => Promise<VM>;
  protected abstract listVMs: (filter?: string) => Promise<VM[]>;
  protected abstract powerOn: (id: string) => Promise<void>;
  protected abstract mapServerObject: (server: any) => VM;
}

export interface VM {
  id: string;
  pass: string;
  host: string;
  private_ip: string;
  state: string;
  tags: string[];
  creation_date: string;
  provider: string;
  originalName?: string;
  large: boolean;
}

export interface AssignedVM extends VM {
  assignTime: number;
  controllerClient?: string;
  creatorUID?: string;
  creatorClientID?: string;
}

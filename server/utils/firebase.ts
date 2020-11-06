import config from '../config';
import * as admin from 'firebase-admin';

if (config.FIREBASE_ADMIN_SDK_CONFIG) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(config.FIREBASE_ADMIN_SDK_CONFIG)
    ),
    databaseURL: config.FIREBASE_DATABASE_URL,
  });
}

export async function validateUserToken(uid: string, token: string) {
  if (!config.FIREBASE_ADMIN_SDK_CONFIG) {
    return undefined;
  }
  const decoded = await admin.auth().verifyIdToken(token);
  if (uid !== decoded.uid) {
    return undefined;
  }
  return decoded;
}

export async function writeData(key: string, value: string) {
  if (!config.FIREBASE_ADMIN_SDK_CONFIG) {
    return;
  }
  await admin.database().ref(key).set(value);
}

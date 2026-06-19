import User from '../models/User.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export const sendPushNotification = async (expoPushToken, title, body, data = {}) => {
  if (!expoPushToken || !expoPushToken.startsWith('ExponentPushToken[')) return;

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to:    expoPushToken,
        sound: 'default',
        title,
        body,
        data,
        badge: 1,
      }),
    });
    const result = await response.json();
    if (result.data?.status === 'error') {
      console.error('[Push] Expo error:', result.data.message);
    }
  } catch (err) {
    console.error('[Push] Failed to send:', err.message);
  }
};

export const sendPushToUser = async (userId, title, body, data = {}) => {
  try {
    const user = await User.findById(userId).select('pushToken').lean();
    if (user?.pushToken) {
      await sendPushNotification(user.pushToken, title, body, data);
    }
  } catch (err) {
    console.error('[Push] sendPushToUser error:', err.message);
  }
};

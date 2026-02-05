import axios from 'axios';

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

export const sendSMSOTP = async (phoneNumber) => {
  const otpCode = Math.floor(100000 + Math.random() * 900000); // 6-digit OTP

  try {
    const response = await axios.post(
      'https://onesignal.com/api/v1/notifications',
      {
        app_id: ONESIGNAL_APP_ID,
        contents: { en: `Your Xpress Vet OTP is: ${otpCode}` },
        sms_from: 'XpressVet', // Your SMS sender ID
        include_phone_numbers: [phoneNumber], // Format: +234xxxxxxxxxx
        sms_media_url: null, // Optional
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${ONESIGNAL_REST_API_KEY}`,
        },
      }
    );

    return { success: true, otpId: response.data.id, otpCode };
  } catch (error) {
    console.error('OneSignal SMS Error:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
};

export const verifySMSOTP = async (otpId, userOtp) => {
  // OneSignal doesn't have direct OTP verification; store OTP in DB or session
  // For simplicity, since we generate it, compare in your auth logic
  // This is a placeholder; implement server-side OTP storage for verification
  return { success: true }; // Assume verified for now
};
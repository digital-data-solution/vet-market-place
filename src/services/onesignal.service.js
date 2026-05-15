import axios from 'axios';

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

export const sendSMSOTP = async (phoneNumber, otpCode) => {
  try {
    const response = await axios.post(
      'https://onesignal.com/api/v1/notifications',
      {
        app_id: ONESIGNAL_APP_ID,
        contents: { en: `Your Xpress Vet OTP is: ${otpCode}` },
        sms_from: 'XpressVet',
        include_phone_numbers: [phoneNumber],
        sms_media_url: null,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${ONESIGNAL_REST_API_KEY}`,
        },
      }
    );

    // Do not return the OTP code from the service in production
    return { success: true, otpId: response.data.id };
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
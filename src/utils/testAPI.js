const BASE_URL = 'http://localhost:5000';

async function testAPI() {
  console.log('🧪 Starting API Tests...\n');

  try {
    // Test 1: Health Check
    console.log('1. Testing Health Endpoint...');
    const healthResponse = await fetch(`${BASE_URL}/health`);
    const healthData = await healthResponse.json();
    console.log('✅ Health:', healthData.status);

    // Test 2: Login
    console.log('\n2. Testing Login...');
    const loginResponse = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'olumide.vet@example.com',
        password: 'password123'
      })
    });

    console.log('Login Response Status:', loginResponse.status);

    if (loginResponse.ok) {
      const loginData = await loginResponse.json();
      console.log('✅ Login successful');
      console.log('Token received:', !!loginData.token);
    } else {
      const errorData = await loginResponse.text();
      console.log('❌ Login failed:', errorData);
    }

  } catch (error) {
    console.error('❌ Test Error:', error.message);
  }
}

testAPI();
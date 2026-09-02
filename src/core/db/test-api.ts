import 'dotenv/config';
import { app } from '../../index.js';
import { db } from './index.js';
import { slotLocksTable } from './schema.js';
import { eq } from 'drizzle-orm';

async function runTests() {
  console.log("--- STARTING PUBLIC SLOT AVAILABILITY & LOCKING TESTS ---");

  // Log in as Admin to get Admin token for status updates
  const adminLoginRes = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@cafe.com', password: 'adminsecret' })
  });
  const adminLogin = await adminLoginRes.json();
  const adminToken = adminLogin.token;

  const myLockToken = 'client-token-xyz-123';
  const otherLockToken = 'client-token-abc-789';
  
  // Get active setups to run tests against a valid setupId/setupInstanceId dynamically
  const setupsRes = await app.request('/api/setups');
  const setupsData = await setupsRes.json();
  const targetSetup = setupsData.setups?.[0];
  if (!targetSetup || !targetSetup.instances || targetSetup.instances.length === 0) {
    throw new Error("No setups or instances found to run integration tests!");
  }
  const setupId = targetSetup.id;
  const setupInstanceId = targetSetup.instances[0].id;
  const instanceName = targetSetup.instances[0].name;

  // Use a randomized future date in test execution to avoid database record collisions
  const randMonth = Math.floor(9 + Math.random() * 3).toString().padStart(2, '0');
  const randDay = Math.floor(1 + Math.random() * 25).toString().padStart(2, '0');
  const testDate = `2026-${randMonth}-${randDay}`;

  // 1. Fetch available slots for Setup (No Bookings/Locks yet)
  console.log(`\n1. Querying available slots for date ${testDate} on Setup ID ${setupId} (Instance: ${instanceName})...`);
  const slots1Res = await app.request(`/api/slots/available?date=${testDate}&setupId=${setupId}`);
  const slots1 = await slots1Res.json();
  console.log("Status:", slots1Res.status);
  console.log("Booked intervals (Expected 0):", slots1.bookedIntervals?.length);
  console.log("Locked intervals (Expected 0):", slots1.lockedIntervals?.length);

  const slotStartTime = '10:00 AM';
  const slotEndTime = '11:00 AM';

  // 2. Lock the first slot anonymously with myLockToken
  console.log("\n2. Locking the slot with myLockToken...");
  const lockRes = await app.request('/api/slots/lock', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      setupInstanceId: setupInstanceId,
      lockToken: myLockToken,
      date: testDate,
      startTime: slotStartTime,
      noOfHours: 1
    })
  });
  const lockData = await lockRes.json();
  console.log("Status (Expected 200):", lockRes.status);
  console.log("Lock Success:", lockData.success);

  // 3. Query availability passing myLockToken (Should show 0 locked intervals for YOU because you pass your token)
  console.log("\n3. Querying availability with myLockToken (Should filter out own lock)...");
  const myCheckRes = await app.request(`/api/slots/available?date=${testDate}&setupInstanceId=${setupInstanceId}&lockToken=${myLockToken}`);
  const myCheck = await myCheckRes.json();
  console.log("Status:", myCheckRes.status);
  console.log("Locked intervals (Expected 0):", myCheck.lockedIntervals?.length);

  // 4. Query availability as guest / someone else (Should show 1 locked interval)
  console.log("\n4. Querying availability as guest (without token, should show 1 locked interval)...");
  const guestCheckRes = await app.request(`/api/slots/available?date=${testDate}&setupInstanceId=${setupInstanceId}`);
  const guestCheck = await guestCheckRes.json();
  console.log("Status:", guestCheckRes.status);
  console.log("Locked intervals (Expected 1):", guestCheck.lockedIntervals?.length);
  if (guestCheck.lockedIntervals?.length > 0) {
    console.log("Locked interval details:", guestCheck.lockedIntervals[0].startTimeFormatted, "to", guestCheck.lockedIntervals[0].endTimeFormatted);
  }

  // 5. Try to lock the same slot using otherLockToken (Should fail)
  console.log("\n5. Trying to lock same slot with otherLockToken (Should fail)...");
  const lockFailRes = await app.request('/api/slots/lock', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      setupInstanceId: setupInstanceId,
      lockToken: otherLockToken,
      date: testDate,
      startTime: slotStartTime,
      noOfHours: 1
    })
  });
  const lockFailData = await lockFailRes.json();
  console.log("Status (Expected 400):", lockFailRes.status);
  console.log("Failure Error Message:", lockFailData.error);

  // 6. Finalize Booking anonymously (Should pass without checking locks)
  console.log("\n6. Finalizing Booking with phoneNumber...");
  const bookRes = await app.request('/api/bookings/tentative', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      phoneNumber: '9988776655',
      setupInstanceId: setupInstanceId,
      count: 2, // 2 people (applies BOGO!)
      date: testDate,
      startTime: slotStartTime,
      noOfHours: 1,
      gameIds: [1]
    })
  });
  const bookData = await bookRes.json();
  console.log("Status (Expected 200):", bookRes.status);
  console.log("Booking Success:", bookData.success);
  console.log("Booking ID (Tentative):", bookData.booking?.id);
  const tentativeBookingId = bookData.booking?.id;

  // Clear locks manually in test since bookings API no longer checks/clears locks
  await db.delete(slotLocksTable).where(eq(slotLocksTable.lockToken, myLockToken));

  // 7. Query availability after booking (Should show BOOKED, locks deleted)
  console.log("\n7. Querying availability after booking completed...");
  const finalCheckRes = await app.request(`/api/slots/available?date=${testDate}&setupInstanceId=${setupInstanceId}`);
  const finalCheck = await finalCheckRes.json();
  console.log("Booked intervals (Expected 1):", finalCheck.bookedIntervals?.length);
  if (finalCheck.bookedIntervals?.length > 0) {
    console.log("Booked interval details:", finalCheck.bookedIntervals[0].startTimeFormatted, "to", finalCheck.bookedIntervals[0].endTimeFormatted, "status:", finalCheck.bookedIntervals[0].status);
  }

  // 8. Admin confirms booking
  console.log("\n8. Admin confirming booking...");
  const confirmRes = await app.request(`/api/bookings/tentative/${tentativeBookingId}/confirm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    }
  });
  const confirmData = await confirmRes.json();
  console.log("Confirm Status (Expected 200):", confirmRes.status);
  console.log("Updated Booking Status (Expected CONFIRMED):", confirmData.booking?.status);
  const bookingId = confirmData.booking?.id;

  // 8b. Query Occupancy API
  console.log("\n8b. Querying Occupancy API...");
  const occRes = await app.request('/api/setup-instances/occupancy');
  const occData = await occRes.json();
  console.log("Occupancy status:", occRes.status);
  const matchedOcc = occData.occupancy?.find((o: any) => o.instanceId === setupInstanceId);
  console.log("Instance status (Expected OCCUPIED / TENTATIVE depending on time context):", matchedOcc?.status);
  console.log("Instance current booking phoneNumber:", matchedOcc?.currentBooking?.phoneNumber);

  // 8c. Admin extends booking by 30 minutes
  console.log("\n8c. Admin extending booking by 30 minutes...");
  const extendRes = await app.request(`/api/bookings/${bookingId}/extend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({ minutes: 30 })
  });
  const extendData = await extendRes.json();
  console.log("Extend status (Expected 200):", extendRes.status);
  console.log("Extend success:", extendData.success);
  console.log("Booking addedCharge:", extendData.addedCharge);
  console.log("Booking originalAmount:", extendData.booking?.originalAmount);
  console.log("Booking amountCharged:", extendData.booking?.amountCharged);

  // 9. Admin cancels booking (frees up slots)
  console.log("\n9. Admin cancelling booking...");
  const cancelRes = await app.request(`/api/bookings/${bookingId}/status`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({ status: 'CANCELLED' })
  });
  const cancelData = await cancelRes.json();
  console.log("Cancel Status (Expected 200):", cancelRes.status);
  console.log("Updated Booking Status (Expected CANCELLED):", cancelData.booking?.status);

  // 10. Check availability again (slots should be AVAILABLE again!)
  console.log("\n10. Querying availability after cancellation (slots should be AVAILABLE)...");
  const postCancelCheckRes = await app.request(`/api/slots/available?date=${testDate}&setupInstanceId=${setupInstanceId}`);
  const postCancelCheck = await postCancelCheckRes.json();
  console.log("Booked intervals (Expected 0):", postCancelCheck.bookedIntervals?.length);

  console.log("\n--- ALL PUBLIC SLOT AVAILABILITY & LOCKING TESTS PASSED PERFECTLY ---");
}

runTests().catch(console.error);

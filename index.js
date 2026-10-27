const crypto = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

initializeApp();

const db = getFirestore();
const region = "asia-south1";
const bookingSlots = ["सुबह 9–12", "दोपहर 12–3", "शाम 3–6", "शाम 6–8"];
const adminEmail = "ia.sukhdev.93@gmail.com";

function isAdmin(auth) {
  return auth.token.email_verified === true &&
    String(auth.token.email || "").toLowerCase() === adminEmail;
}

function slotId(providerId, date, time) {
  return crypto.createHash("sha256")
    .update(`${providerId}\n${date}\n${time}`)
    .digest("hex");
}

function validateDateAndTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !bookingSlots.includes(time)) {
    throw new HttpsError("invalid-argument", "Choose a valid date and service time.");
  }
  const [year, month, day] = date.split("-").map(Number);
  const parsedDate = new Date(Date.UTC(year, month - 1, day));
  if (parsedDate.toISOString().slice(0, 10) !== date) {
    throw new HttpsError("invalid-argument", "Choose a valid service date.");
  }
  const indiaDateParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date()).map((part) => [part.type, part.value])
  );
  const todayInIndia = `${indiaDateParts.year}-${indiaDateParts.month}-${indiaDateParts.day}`;
  if (date < todayInIndia) {
    throw new HttpsError("invalid-argument", "Choose today or a future service date.");
  }
}

function validateProviderSchedule(provider, date, time) {
  if (provider.availability === "unavailable") {
    throw new HttpsError("failed-precondition", "This professional is not accepting bookings.");
  }
  const [year, month, day] = date.split("-").map(Number);
  const weekDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const schedule = provider.availabilitySchedule;
  const availableSlots = !schedule
    ? bookingSlots
    : Array.isArray(schedule[String(weekDay)])
      ? schedule[String(weekDay)]
      : [];
  if (!availableSlots.includes(time)) {
    throw new HttpsError("failed-precondition", "This professional is not available at that time.");
  }
}

exports.acceptBooking = onCall({ region }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to accept a booking.");
  const bookingId = String(request.data?.bookingId || "");
  if (!bookingId || bookingId.length > 100) {
    throw new HttpsError("invalid-argument", "A valid booking ID is required.");
  }
  const bookingRef = db.collection("bookings").doc(bookingId);
  let result;

  await db.runTransaction(async (transaction) => {
    const bookingSnapshot = await transaction.get(bookingRef);
    if (!bookingSnapshot.exists) throw new HttpsError("not-found", "Booking not found.");
    const booking = bookingSnapshot.data();
    const providerRef = db.collection("serviceProviders").doc(booking.providerId);
    const providerSnapshot = await transaction.get(providerRef);
    if (!providerSnapshot.exists) throw new HttpsError("failed-precondition", "Professional profile not found.");
    const provider = providerSnapshot.data();
    const isAssignedProvider = provider.isUserProfile === true && provider.ownerId === request.auth.uid;
    if (!isAdmin(request.auth) && !isAssignedProvider) {
      throw new HttpsError("permission-denied", "Only the assigned professional can accept this booking.");
    }
    if (booking.status !== "Pending") {
      throw new HttpsError("failed-precondition", "This booking is no longer pending.");
    }
    validateDateAndTime(booking.date, booking.time);
    validateProviderSchedule(provider, booking.date, booking.time);
    const reservationId = slotId(booking.providerId, booking.date, booking.time);
    const reservationRef = db.collection("slotReservations").doc(reservationId);
    const reservationSnapshot = await transaction.get(reservationRef);
    if (reservationSnapshot.exists && reservationSnapshot.data().bookingId !== bookingId) {
      throw new HttpsError("already-exists", "This service time has already been accepted for another booking.");
    }
    const now = new Date().toISOString();
    const actor = isAssignedProvider ? provider.name : "GharSeva Admin";
    const timeline = [...(Array.isArray(booking.timeline) ? booking.timeline : []), {
      type: "status",
      status: "Accepted",
      label: "Provider ने booking स्वीकार की",
      actor,
      actorId: request.auth.uid,
      createdAt: now
    }];
    transaction.set(reservationRef, {
      bookingId,
      providerId: booking.providerId,
      date: booking.date,
      time: booking.time,
      createdAt: now
    });
    transaction.update(bookingRef, {
      status: "Accepted",
      timeline,
      reservedSlotId: reservationId,
      acceptedAt: now
    });
    result = { status: "Accepted", timeline, reservedSlotId: reservationId };
  });
  return result;
});

exports.rescheduleBooking = onCall({ region }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to reschedule a booking.");
  const bookingId = String(request.data?.bookingId || "");
  const date = String(request.data?.date || "");
  const time = String(request.data?.time || "");
  if (!bookingId || bookingId.length > 100) {
    throw new HttpsError("invalid-argument", "A valid booking ID is required.");
  }
  validateDateAndTime(date, time);
  const bookingRef = db.collection("bookings").doc(bookingId);
  let result;

  await db.runTransaction(async (transaction) => {
    const bookingSnapshot = await transaction.get(bookingRef);
    if (!bookingSnapshot.exists) throw new HttpsError("not-found", "Booking not found.");
    const booking = bookingSnapshot.data();
    if (booking.userId !== request.auth.uid || booking.userEmail !== request.auth.token.email) {
      throw new HttpsError("permission-denied", "Only the customer can reschedule this booking.");
    }
    if (!["Pending", "Accepted"].includes(booking.status)) {
      throw new HttpsError("failed-precondition", "Only pending or accepted bookings can be rescheduled.");
    }
    if (booking.date === date && booking.time === time) {
      throw new HttpsError("invalid-argument", "Choose a different service time.");
    }
    const providerRef = db.collection("serviceProviders").doc(booking.providerId);
    const providerSnapshot = await transaction.get(providerRef);
    if (!providerSnapshot.exists) throw new HttpsError("failed-precondition", "Professional profile not found.");
    const provider = providerSnapshot.data();
    validateProviderSchedule(provider, date, time);

    const isReserved = booking.status === "Accepted" && typeof booking.reservedSlotId === "string";
    const nextReservationId = isReserved ? slotId(booking.providerId, date, time) : null;
    const nextReservationRef = nextReservationId
      ? db.collection("slotReservations").doc(nextReservationId)
      : null;
    const oldReservationRef = isReserved
      ? db.collection("slotReservations").doc(booking.reservedSlotId)
      : null;
    const nextReservationSnapshot = nextReservationRef
      ? await transaction.get(nextReservationRef)
      : null;
    const oldReservationSnapshot = oldReservationRef
      ? await transaction.get(oldReservationRef)
      : null;
    if (nextReservationSnapshot?.exists && nextReservationSnapshot.data().bookingId !== bookingId) {
      throw new HttpsError("already-exists", "This service time has already been accepted for another booking.");
    }
    if (oldReservationRef && oldReservationSnapshot?.exists &&
        oldReservationSnapshot.data().bookingId !== bookingId) {
      throw new HttpsError("failed-precondition", "The current booking slot could not be verified.");
    }

    const now = new Date().toISOString();
    const timeline = [...(Array.isArray(booking.timeline) ? booking.timeline : []), {
      type: "schedule",
      label: "ग्राहक ने booking का समय बदला",
      actor: booking.customer,
      actorId: request.auth.uid,
      previousDate: booking.date,
      previousTime: booking.time,
      date,
      time,
      createdAt: now
    }];
    if (oldReservationRef && booking.reservedSlotId !== nextReservationId) {
      transaction.delete(oldReservationRef);
    }
    if (nextReservationRef) {
      transaction.set(nextReservationRef, {
        bookingId,
        providerId: booking.providerId,
        date,
        time,
        createdAt: now
      });
    }
    transaction.update(bookingRef, {
      date,
      time,
      timeline,
      reservedSlotId: nextReservationId
    });
    result = { date, time, timeline, reservedSlotId: nextReservationId };
  });
  return result;
});

exports.cancelBooking = onCall({ region }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to cancel a booking.");
  const bookingId = String(request.data?.bookingId || "");
  if (!bookingId || bookingId.length > 100) {
    throw new HttpsError("invalid-argument", "A valid booking ID is required.");
  }
  const bookingRef = db.collection("bookings").doc(bookingId);
  let result;

  await db.runTransaction(async (transaction) => {
    const bookingSnapshot = await transaction.get(bookingRef);
    if (!bookingSnapshot.exists) throw new HttpsError("not-found", "Booking not found.");
    const booking = bookingSnapshot.data();
    if (booking.userId !== request.auth.uid || booking.userEmail !== request.auth.token.email) {
      throw new HttpsError("permission-denied", "Only the customer can cancel this booking.");
    }
    if (!["Pending", "Accepted"].includes(booking.status)) {
      throw new HttpsError("failed-precondition", "Only pending or accepted bookings can be cancelled.");
    }
    const reservationRef = booking.status === "Accepted" && typeof booking.reservedSlotId === "string"
      ? db.collection("slotReservations").doc(booking.reservedSlotId)
      : null;
    const reservationSnapshot = reservationRef ? await transaction.get(reservationRef) : null;
    if (reservationSnapshot?.exists && reservationSnapshot.data().bookingId !== bookingId) {
      throw new HttpsError("failed-precondition", "The reserved service time could not be verified.");
    }
    const now = new Date().toISOString();
    const timeline = [...(Array.isArray(booking.timeline) ? booking.timeline : []), {
      type: "status",
      status: "Cancelled",
      label: "ग्राहक ने booking cancel की",
      actor: booking.customer,
      actorId: request.auth.uid,
      createdAt: now
    }];
    if (reservationRef && reservationSnapshot?.exists) transaction.delete(reservationRef);
    transaction.update(bookingRef, {
      status: "Cancelled",
      cancelledAt: now,
      timeline,
      reservedSlotId: null
    });
    result = { status: "Cancelled", cancelledAt: now, timeline, reservedSlotId: null };
  });
  return result;
});

exports.releaseBookingSlot = onDocumentWritten({
  document: "bookings/{bookingId}",
  region
}, async (event) => {
  const before = event.data?.before.exists ? event.data.before.data() : null;
  const after = event.data?.after.exists ? event.data.after.data() : null;
  if (!before?.reservedSlotId) return;
  const changedReservation = before.reservedSlotId !== after?.reservedSlotId;
  const wasReserved = ["Accepted", "In Progress"].includes(before.status);
  const reservationEnded = wasReserved && !["Accepted", "In Progress"].includes(after?.status);
  if (!changedReservation && !reservationEnded) return;
  const reservationRef = db.collection("slotReservations").doc(before.reservedSlotId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reservationRef);
    if (snapshot.exists && snapshot.data().bookingId === event.params.bookingId) {
      transaction.delete(reservationRef);
    }
  });
});

exports.notifyBookingUpdate = onDocumentWritten({
  document: "bookings/{bookingId}",
  region
}, async (event) => {
  const before = event.data?.before.exists ? event.data.before.data() : null;
  const after = event.data?.after.exists ? event.data.after.data() : null;
  if (!after) return;

  const previousComplaints = new Map((before?.complaints || []).map((complaint) => [complaint.id, complaint]));
  const changedComplaint = (after.complaints || []).find((complaint) => {
    const oldComplaint = previousComplaints.get(complaint.id);
    return !oldComplaint || oldComplaint.status !== complaint.status ||
      oldComplaint.updatedAt !== complaint.updatedAt;
  });
  const isNewBooking = !before;
  const changed = isNewBooking || before.status !== after.status ||
    before.date !== after.date || before.time !== after.time ||
    JSON.stringify(before.priceProposal || null) !== JSON.stringify(after.priceProposal || null) ||
    Boolean(changedComplaint);
  if (!changed) return;

  const providerSnapshot = await db.collection("serviceProviders").doc(after.providerId).get();
  const providerOwnerId = providerSnapshot.exists ? providerSnapshot.data().ownerId : null;
  const proposalChanged = JSON.stringify(before?.priceProposal || null) !==
    JSON.stringify(after.priceProposal || null);
  const actorId = changedComplaint
    ? (previousComplaints.has(changedComplaint.id)
      ? changedComplaint.resolvedBy || after.timeline?.[after.timeline.length - 1]?.actorId || null
      : changedComplaint.submittedBy)
    : proposalChanged
      ? after.priceProposal?.respondedBy || after.priceProposal?.proposedBy || null
      : after.timeline?.[after.timeline.length - 1]?.actorId || null;
  let title = "GharSeva · Booking update";
  let body = `${after.category || "Service"} · ${after.date || ""} ${after.time || ""} · ${after.status || "Pending"}`;
  if (changedComplaint) {
    title = changedComplaint.status === "Resolved"
      ? "GharSeva · Complaint update"
      : "GharSeva · New complaint";
    body = `Ticket ${changedComplaint.id} · ${changedComplaint.status === "Resolved" ? "review complete" : "review required"}`;
  } else if (after.priceProposal?.status === "pending" &&
      before?.priceProposal?.status !== "pending") {
    title = "GharSeva · Price approval needed";
    body = `Review the additional charges for booking ${after.id}.`;
  } else if (isNewBooking) {
    title = "GharSeva · New service request";
    body = `${after.category || "Service"} · ${after.date || ""} ${after.time || ""}`;
  }

  const recipientIds = isNewBooking
    ? [providerOwnerId]
    : [after.userId, providerOwnerId];
  const uniqueRecipientIds = [...new Set(recipientIds.filter((uid) => uid && uid !== actorId))];
  for (const uid of uniqueRecipientIds) {
    const tokenSnapshot = await db.collection("users").doc(uid).collection("pushTokens").get();
    const tokenDocs = tokenSnapshot.docs.filter((document) =>
      typeof document.data().token === "string" && document.data().token.length > 0
    );
    for (let offset = 0; offset < tokenDocs.length; offset += 500) {
      const batch = tokenDocs.slice(offset, offset + 500);
      if (!batch.length) continue;
      const response = await getMessaging().sendEachForMulticast({
        tokens: batch.map((document) => document.data().token),
        notification: { title, body },
        data: {
          bookingId: String(after.id || event.params.bookingId),
          status: String(after.status || "Pending"),
          url: "/"
        },
        webpush: {
          notification: {
            icon: "/ghar-seva-192.png",
            data: { bookingId: String(after.id || event.params.bookingId), url: "/" }
          }
        }
      });
      const cleanup = db.batch();
      let cleanupCount = 0;
      response.responses.forEach((result, index) => {
        if (result.success) return;
        const code = result.error?.code || "";
        if (code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token") {
          cleanup.delete(batch[index].ref);
          cleanupCount += 1;
        } else {
          console.error("Could not send booking push notification.", {
            uid,
            bookingId: event.params.bookingId,
            code
          });
        }
      });
      if (cleanupCount) await cleanup.commit();
    }
  }
});

// One free-text note per payment (bank_transactions.note). The backend
// validator and the frontend textarea's maxLength must agree on the cap, or
// the box lets a manager type what the save then refuses.
export const PAYMENT_NOTE_MAX = 280;

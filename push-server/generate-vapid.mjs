import { generateVapidKeys } from "@mmmike/web-push/vapid";

const keys = await generateVapidKeys();
console.log("VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey);
console.log("VAPID_SUBJECT=mailto:replace-with-your-contact@example.com");
console.log("\nKeep VAPID_PRIVATE_KEY secret. Never commit it or send it in chat.");

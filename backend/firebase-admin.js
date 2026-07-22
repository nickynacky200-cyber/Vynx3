// Verifies the ID tokens issued by Firebase Auth on the client. Needs a
// service account with the "Firebase Authentication Admin" role — see
// .env.example for where to get the three values below (Firebase console
// → Project settings → Service accounts → Generate new private key).
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // .env files can't hold real newlines, so service-account private
      // keys are stored with literal "\n" and unescaped here.
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

module.exports = admin;

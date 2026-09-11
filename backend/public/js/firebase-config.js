// Firebase console → Project settings → General → "Your apps" → Web app →
// SDK setup and configuration. Paste your web app's config below.
//
// This config is safe to expose in client-side code — it's not a secret,
// it just tells the browser which Firebase project to talk to. Actual
// access control happens via Firebase Auth + your backend verifying ID
// tokens (see backend/firebase-admin.js).
const firebaseConfig = {
  apiKey: 'AIzaSyB9hfWljY4q16LbTs6WuuZv9cOtC9sfkCQ',
  authDomain: 'vynx-d98da.firebaseapp.com',
  projectId: 'vynx-d98da',
  storageBucket: 'vynx-d98da.firebasestorage.app',
  messagingSenderId: '1004381844110',
  appId: '1:1004381844110:web:9421712ee5cea5badecfdf',
};

firebase.initializeApp(firebaseConfig);

// Used throughout api.js and the auth pages as the global `auth` handle.
const auth = firebase.auth();

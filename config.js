// Firebase web settings. These are public by design: access is protected by
// Firebase Auth and the Firestore security rules in firebase/firestore.rules.
window.APP_CONFIG = {
  firebase: {
    apiKey: 'AIzaSyDpuSeTEuEkEhcCMJ-nASM31Ay-pTlG5t0',
    authDomain: 'expencetracker-b145d.firebaseapp.com',
    projectId: 'expencetracker-b145d',
    storageBucket: 'expencetracker-b145d.firebasestorage.app',
    messagingSenderId: '968790491853',
    appId: '1:968790491853:web:11e3350642c974398a9f84',
  },
  // Web push public key (Firebase console → Project settings → Cloud Messaging → Web Push certificates)
  vapidKey: 'BHfR3HPDaZdYNIgxbw-gSKkRzxlzn6ImJX0HGE8iAqfKUFonycFzo0mTjlGjP_9Abk-x0w1OAZvYtSeATe0sG00',
  // Mobile numbers are used as usernames: 9xxxxxxxxx@<emailDomain> (never emailed).
  emailDomain: 'expensetracker.app',
};

const express = require('express');
const router = express.Router();
const passport = require('../config/passport');

// Middleware untuk memastikan user sudah login
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ success: false, error: 'Unauthorized: Please log in with GitHub' });
}

// GET /auth/github - Initiate GitHub OAuth flow
router.get('/github', passport.authenticate('github', { scope: ['repo', 'user:email', 'read:org'] }));

// GET /auth/github/callback - GitHub callback URL (DIPERBAIKI)
router.get('/github/callback', 
  passport.authenticate('github', { failureRedirect: '/login-error' }),
  (req, res) => {
    // REDIRECT KE ENDPOINT API YANG VALID UNTUK VERIFIKASI SESI
    // Karena kita tidak punya frontend, kita redirect ke endpoint user itu sendiri.
    // Cookies connect.sid sudah diset di response header sebelum redirect ini.
    res.redirect(`/auth/user`); 
  }
);

// GET /auth/logout - Logout user
router.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) { return next(err); }
    res.json({ success: true, message: 'Logout successful' });
  });
});

// GET /auth/user - Get current logged-in user information
router.get('/user', ensureAuthenticated, (req, res) => {
  res.json({
    success: true,
    message: "Authentication successful. User session is active.",
    data: {
      id: req.user._id,
      github_id: req.user.github_id,
      username: req.user.username,
      displayName: req.user.display_name,
      // Access token TIDAK dikembalikan untuk keamanan
    }
  });
});

module.exports = { router, ensureAuthenticated };

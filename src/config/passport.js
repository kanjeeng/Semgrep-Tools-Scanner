// kanjeeng/semgrep-tools-scanner/Semgrep-Tools-Scanner-ab6ccf6689bef869b61a62450b1d742fcfee7cdd/src/config/passport.js (NEW FILE)
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const User = require('../models/User');

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL;

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    if (user) {
        done(null, user);
    } else {
            done(null, false);
    }
  } catch (err) {
    done(err, false);
  }
});

passport.use(new GitHubStrategy({
  clientID: GITHUB_CLIENT_ID,
  clientSecret: GITHUB_CLIENT_SECRET,
  callbackURL: GITHUB_CALLBACK_URL,
  scope: ['repo', 'user:email', 'read:org'] // Request 'repo' scope for private repo access
},
async (accessToken, refreshToken, profile, done) => {
  try {
    // Find or create user in database
    const user = await User.findOrCreate(profile, accessToken);
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

module.exports = passport;
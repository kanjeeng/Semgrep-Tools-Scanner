// kanjeeng/semgrep-tools-scanner/Semgrep-Tools-Scanner-ab6ccf6689bef869b61a62450b1d742fcfee7cdd/src/models/User.js (NEW FILE)
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  github_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  username: {
    type: String,
    required: true,
    trim: true,
    unique: true
  },
  display_name: String,
  profile_url: String,
  access_token: {
    type: String,
    required: true // Store token for private repo access
  },
  created_at: {
    type: Date,
    default: Date.now
  }
});

userSchema.statics.findOrCreate = async function(profile, accessToken) {
  let user = await this.findOne({ github_id: profile.id });
  
  if (user) {
    // Update token if user exists
    user.access_token = accessToken;
    await user.save();
    return user;
  }

  // Create new user
  user = new this({
    github_id: profile.id,
    username: profile.username,
    display_name: profile.displayName || profile.username,
    profile_url: profile.profileUrl,
    access_token: accessToken
  });

  await user.save();
  return user;
};

module.exports = mongoose.model('User', userSchema);
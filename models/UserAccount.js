const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserAccountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 180 },
    password: { type: String, required: true, minlength: 8 },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

UserAccountSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

UserAccountSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

UserAccountSchema.methods.toSafeJSON = function () {
  return { id: this._id, name: this.name, email: this.email, lastLoginAt: this.lastLoginAt };
};

module.exports = mongoose.model('UserAccount', UserAccountSchema);

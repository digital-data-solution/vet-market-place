import mongoose from 'mongoose';

// Xpress Vet Blog — admin-authored articles (vet care tips, product news,
// company updates) shown on the public front end and optionally emailed to
// users. Content is authored as Markdown (`contentMarkdown`), the single
// source of truth — rendered client-side in the app (react-native-markdown-
// display) and server-side to HTML for the email send (services/
// blogEmail.service.js, via `marked`). Same "draft, then a human decides to
// publish/send" philosophy as CoursePublishDraft/AdminEmailCampaign — nothing
// here reaches a reader until an admin explicitly clicks Publish, and emailing
// it out is a separate, explicit action from publishing.
const blogPostSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },

  // URL-safe, unique, editable by admin but auto-suggested from title.
  // Public post URL: xpressvetmarketplace.com/Blog/<slug>
  slug: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 180 },

  // Short teaser shown on the list view and in the email send — not derived
  // automatically from content, admin writes it deliberately for quality.
  excerpt: { type: String, required: true, trim: true, maxlength: 300 },

  contentMarkdown: { type: String, required: true },

  coverImageUrl:      { type: String, default: null },
  coverImagePublicId: { type: String, default: null },

  tags: { type: [String], default: [] },

  authorName: { type: String, trim: true, default: 'Xpress Vet Team' },

  status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
  publishedAt: { type: Date, default: null },

  viewCount: { type: Number, default: 0 },

  // Email-send tracking — set once an admin dispatches this post as a
  // campaign (services/blogEmail.service.js). A post can be re-sent later
  // (e.g. a big update), each send overwrites these with the latest send's
  // numbers; full history isn't kept here, just "was this ever emailed and
  // how did the last send go" — enough for the admin dashboard's needs.
  emailStatus:        { type: String, enum: ['never_sent', 'sending', 'sent', 'failed'], default: 'never_sent' },
  emailSentAt:         { type: Date, default: null },
  emailTargetType:     { type: String, enum: ['user', 'segment', 'all', null], default: null },
  emailSegmentKey:      { type: String, default: null },
  emailRecipientCount: { type: Number, default: 0 },
  emailSkippedCount:   { type: Number, default: 0 },
  emailError:          { type: String, default: null },

  createdByEmail: { type: String, default: null },
}, { timestamps: true });

blogPostSchema.index({ status: 1, publishedAt: -1 });

export default mongoose.model('BlogPost', blogPostSchema);

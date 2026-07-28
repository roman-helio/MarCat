const assert = require('node:assert/strict')
const { parseReviewPageHtml } = require('../packages/core/dist/index.cjs')

const google = parseReviewPageHtml(
  'google_play_reviews',
  'https://play.google.com/store/apps/details?id=example.game',
  `
    <div class="RHo1pe" data-review-id="gp-1">
      <div class="X5PpBb">Mira</div>
      <div class="iXRFPc" aria-label="Rated 4 stars out of five stars"></div>
      <span class="bp9Aid">2026-07-20</span>
      <div class="h3YV2d">Great game, but the save button is hard to find.</div>
      <div class="ras4vb">Thanks — the next build makes it clearer.</div>
    </div>
  `,
)
assert.equal(google.length, 1)
assert.equal(google[0].externalId, 'gp-1')
assert.equal(google[0].rating, 4)
assert.equal(google[0].developerReply, 'Thanks — the next build makes it clearer.')

const itch = parseReviewPageHtml(
  'itch_comments',
  'https://studio.itch.io/example-game',
  `
    <div class="community_post" id="post-42">
      <div class="post_header"><a class="user_link" href="https://itch.io/profile/fox">Fox</a></div>
      <abbr class="timeago" title="2026-07-21T08:30:00Z"></abbr>
      <div class="post_body">Could you add keyboard remapping?</div>
    </div>
  `,
)
assert.equal(itch.length, 1)
assert.equal(itch[0].externalId, 'post-42')
assert.equal(itch[0].authorName, 'Fox')
assert.equal(itch[0].kind, 'comment')

const jsonLd = parseReviewPageHtml(
  'crazygames_comments',
  'https://www.crazygames.com/game/example',
  `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    review: {
      '@type': 'Review',
      '@id': 'review-7',
      author: { '@type': 'Person', name: 'Alex' },
      reviewBody: 'Fast and fun.',
      reviewRating: { ratingValue: 5 },
      datePublished: '2026-07-22',
    },
  })}</script>`,
)
assert.equal(jsonLd.length, 1)
assert.equal(jsonLd[0].externalId, 'review-7')
assert.equal(jsonLd[0].body, 'Fast and fun.')

console.log('review connector parser tests passed')

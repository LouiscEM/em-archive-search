import { page, html } from './_shared.js';

const prompt = (q, label = q) =>
  `<a href="/?q=${encodeURIComponent(q)}&mode=moments&sort=new">${label} &rarr;</a>`;

export async function onRequestGet() {
  return html(page('How to use Archive Search', `
    <h1>Find the clips worth replaying.</h1>
    <p class="lede">A quick guide for the offsite planning session. The goal is to
      leave with a shortlist of moments, not to read every result.</p>

    <div class="guide-grid">
      <div class="guide-card"><h2>1. Start with Search</h2>
        <p>Use words likely to have been spoken. Choose <b>Moments</b> for exact quotes
          and timestamps; choose <b>Episodes</b> when you only need the episode.</p>
        <ul><li>Use the <b>Month</b>, show and speaker filters to narrow the year.</li>
          <li>Put quotes around a phrase when the wording matters.</li>
          <li>Try fewer words if a search comes back empty.</li></ul></div>
      <div class="guide-card"><h2>2. Verify the moment</h2>
        <p>Open the transcript for context. When a YouTube timestamp is available,
          use <b>Watch this moment</b> to jump directly to the clip.</p>
        <ol><li>Read the lines immediately before and after it.</li>
          <li>Check that the speaker label is right.</li>
          <li>Copy the episode title, timestamp and why it belongs in the video.</li></ol></div>
      <div class="guide-card"><h2>3. Use Ask for judgement</h2>
        <p>Ask is useful for broad, subjective questions such as “best advice” or
          “times someone changed their mind”. Treat it as a shortlist generator and
          verify every result against the transcript or video.</p></div>
      <div class="guide-card"><h2>4. Know the gaps</h2>
        <p>Older episodes and audio-only shows are less likely to have transcripts or
          timestamped video. No result means “not found in the searchable transcripts”,
          not necessarily “it never happened”.</p></div>
    </div>

    <h2>Good starting points for this session</h2>
    <div class="guide-grid prompt-list">
      <div class="guide-card"><h2>Community</h2>
        ${prompt('community')}${prompt('listener')}${prompt('investing journey')}
        ${prompt('changed my life')}</div>
      <div class="guide-card"><h2>Funny and human</h2>
        ${prompt('funny')}${prompt('laugh')}${prompt('mistake')}${prompt('embarrassing')}</div>
      <div class="guide-card"><h2>Progress and impact</h2>
        ${prompt('first investment')}${prompt('proud')}${prompt('milestone')}
        ${prompt('best advice')}</div>
      <div class="guide-card"><h2>Then narrow it</h2>
        <p>Choose the relevant month, show or speaker on the results page. For the
          strongest clips, switch the sort to <b>Best performing</b> as a final lens,
          not as the only definition of a good moment.</p></div>
    </div>`, 'guide'));
}

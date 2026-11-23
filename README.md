# ACG IBA - website

Static site for the ACG IBA pipeline program (UTSA → UT Austin → investment banking).
No build step, no dependencies, no backend. Plain HTML/CSS/JS, deployable free on GitHub Pages.

---

## Files

```
index.html          Home - about the club, program model, leadership
apply.html          Requirements and application process (public)
roster.html         GATED - rankings, scored profiles, coach mock logging
timeline.html       GATED - transfer + recruiting timeline
coursework.html     GATED - competency-to-coursework map
assets/style.css    All styling. Design tokens at the top.
assets/app.js       Rating engine, data layer, access gate.  <-- EDIT CONFIG HERE
data/roster.json    Roster + mock log (currently SAMPLE DATA)
data/materials.json      Study material manifest for the coursework page
files/                   Study material PDFs - see files/README.txt
img/                Headshots + og-cover.png (social share image)
404.html            Served by GitHub Pages for any unmatched URL
robots.txt          Keeps member pages out of search results (courtesy, not protection)
.nojekyll           Stops GitHub Pages running the tree through Jekyll
```

---

## Deploying to GitHub Pages

1. Create a repo. Name it `acg-iba` (site lands at `username.github.io/acg-iba`)
   or `username.github.io` (lands at the root domain).
2. Upload every file, preserving the `assets/` and `data/` folders.
3. Repo → **Settings** → **Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
4. Wait 1–2 minutes. The URL appears at the top of that same Settings → Pages screen.

The repo must be **public** for free GitHub Pages (private repos need a paid plan).
That means every file in it is publicly readable by URL - see the security note below.

### Custom domain (optional)
Buy the domain, add it under Settings → Pages → Custom domain, and point a CNAME record
at `username.github.io` with your registrar. ~$10–15/yr. The `github.io` URL works fine
without this.

---

## Access codes

Two roles: **coach** (view everything, add members, log mocks, export data) and
**member** (view roster, ratings, timeline, coursework).

**The codes are not written down in this repository, and must never be.** This repo
is public, so anything committed here is readable by anyone. Share the codes directly
with the people who need them.

To change a code, hash it and paste the hash into `GATE_HASHES` in `assets/app.js`:

```bash
echo -n "yournewcode" | shasum -a 256
```


### ⚠️ This is not real security

GitHub Pages serves static files. There is no server to verify a password, so the gate is
enforced in the browser and the code hashes ship inside `app.js`. Anyone who opens devtools
can get past it, and **`data/roster.json` is directly downloadable by URL** regardless of the gate.

Practical implications:
- Do not put anything in this repo you'd mind a stranger reading - no grades, no private
  contact details, no candid written assessments you wouldn't show the member.
- Keep coach notes factual and professional. Assume the member will read them.

If you need genuine access control later, host the same files on **Cloudflare Pages** (also free)
and put Cloudflare Access in front of the gated routes - that gives real email-based login.
No code changes needed; it's a hosting swap.

---

## The rating model

All weights live in the `MODEL` object at the top of `assets/app.js`. Change a number there
and every page recalculates - the home page and coursework page read their weight tables
straight from that object, so they can never drift out of sync.

**Pillars** (share of overall): Technical 40% · Behavioral 40% · Markets 20% = 100% ✓

**Technical sub-weights:** accounting 30, corp finance 10, bonds 5, LBO 10, M&A 15,
DCF 10, EV 10, valuation 10 = **100 ✓** (accounting was lowered from 40 to 30 to make it
total exactly 100, so no normalisation is in play).

**Behavioral:** speaking 50 / stories & prep 50 = 100 ✓

### Scoring rules

**Rule 1 - five scores exist, nothing in between.** Every answer gets one of:

| Score | Means |
| --- | --- |
| 0 | Didn't know it |
| 2.5 | Knew the term, couldn't explain it |
| 5 | Correct but incomplete, or needed prompting |
| 7.5 | Complete and correct |
| 10 | Complete, correct, explained why - unprompted |

Removing the values in between is what makes two coaches agree. Nobody can
reliably defend a 6 over a 7.

**Rule 2 - difficulty weights the answer, asymmetrically.** Every question in
`data/questions.json` is tagged E, M or H. How much it pulls on the average
depends on whether the answer was above or below neutral:

| Difficulty | Answered above 5 | Answered below 5 |
| --- | --- | --- |
| Easy | 0.25x | 2.5x |
| Medium | 0.75x | 1.5x |
| Hard | 1x | 1x |

Getting an easy question right barely moves the score. Missing one costs a lot.
Hard questions are the baseline both ways. A score of exactly 5 weighs 1x.

Behaviour this produces:

| Candidate | Score |
| --- | --- |
| Aces an all-easy mock | 10 |
| Solid everywhere (all 7.5s) | 7.5 |
| Misses one easy, rest solid | 6.2 |
| Aces easy, misses every hard | 3.3 |
| Misses easy, aces hard | 1.7 |

Change the numbers in `DIFFICULTY` in `assets/app.js` to retune.

### How a score is calculated

- A mock scores only the competencies it actually tested. Untested competencies are excluded
  entirely - they do not count as zero.
- Within a competency, mocks are weighted by recency with `DECAY = 2`: the newest mock counts
  2× the previous one, 4× the one before that, 8× the one before that.
  *Example: scores of 6 → 8 → 9 give (6×1 + 8×2 + 9×4) ÷ 7 = 8.3*
- A pillar score is the weighted mean of its tested sub-metrics, with weights renormalised
  over only those tested.
- Overall is the weighted mean of the pillars that have data, again renormalised.
- A member with no mocks shows as unrated rather than as a zero.

Change `DECAY` in `app.js` to tune recency bias: `1` = flat average, `3` = more aggressive.

---

## Data workflow (important)

There is no database. Here's the loop:

1. The site loads `data/roster.json` on page load.
2. A coach adds members / logs mocks in the browser. **This saves to that browser only**
   (localStorage) - the other coach will not see it.
3. The coach clicks **Export roster.json**, which downloads the updated file.
4. Commit that file over `data/roster.json` in the repo.
5. Now everyone sees it.

So: one of you should own committing. If you both log mocks in your own browsers without
exporting, your two versions will diverge and whoever exports last wins.

**If the site shows the wrong data:** the strip at the top of Roster & Ratings says
which copy you are looking at - this browser's saved copy, or the committed
`roster.json`. Coaches get a **Reload from file** button that throws away the local
copy and re-reads what is committed.

A local copy only takes precedence when it actually contains members or mocks. An
empty one is ignored and cleared, so committing data to the repo always shows up.

---


## What the program covers (as stated on the site)

Mock interviews and ratings, plus: LinkedIn profile review, résumé conversion to banking
format, structured technical training across the rated competencies, an opportunities board,
and alumni/industry introductions through coaches.

---

## Membership rules as implemented

- Target applicant: **UTSA freshman intending to transfer to UT Austin**, CAP students included
- Major: **business-adjacent, CAP, or intent to move into one**. The major need not be declared yet
- Intent: must **actually want to do IB**, or genuinely want to find out
- GPA: **3.5 at UTSA, or no GPA yet** (first-semester students are not penalised)
- Required: **active member of Alpha Kappa Psi, the Investment Society, or ACG**
- **Target summer does not matter** and is not asked for
- Process: application -> **one interview covering technical and behavioral** -> rolling decision
- Technicals are **not weighted heavily in the admission decision** (this is separate from the
  member rating model, where technical is 40% of overall)
- Coaches: **current UT Austin students who transferred from UTSA**

### A CAP detail worth knowing

CAP guarantees transfer admission to UT Austin's **College of Liberal Arts**, not to a specific
major. A CAP student aiming at McCombs still competes in the transfer applicant pool. The apply
page states this so CAP members are not operating on a false assumption.

---

## Social share image

`img/og-cover.png` is the preview card shown when the link is posted to LinkedIn,
Instagram, Slack or iMessage. **One change is required once the site is live:** the
`og:image` tag in each page currently holds a relative path, and most link previewers
do not resolve those. Replace it with the full absolute URL, and add `og:url`:

```html
<meta property="og:image" content="https://YOURNAME.github.io/acg-iba/img/og-cover.png">
<meta property="og:url"   content="https://YOURNAME.github.io/acg-iba/">
```

---

## Before launch - checklist

Placeholders have been removed and every page now reads as finished copy. What
remains are decisions only you can make:

- [ ] The apply CTA currently routes to **ben.lavie@utexas.edu**. Swap it for a
      Google Form link when you have one.
- [ ] No **Instagram** link is in the footer. Add one if the club has an account.
- [ ] **Dues**: the site says nothing about a fee. Add a line if one exists.
- [ ] Verify the **UT transfer deadline** and firm application windows yourself.
      The timeline describes stages and tells members to check primary sources,
      but carries no specific dates.
- [ ] Fill in real **course numbers** on the coursework page if you want them named.
- [ ] Change both **access codes** from the defaults.
- [ ] Set absolute `og:image` and `og:url` once the site has its real address.
- [ ] Confirm with whoever charters the org that the **ACG name** can be used publicly.

---

## Adding study materials

The coursework page builds its material list from `data/materials.json`, so adding
a deck is two steps and no HTML:

1. Drop the PDF in `files/`
2. Add an entry under the matching competency key in `data/materials.json`

Full instructions and the entry format are in `files/README.txt`. Competencies with
no materials show "No materials posted yet" rather than a broken link.

**Anything in `files/` is publicly downloadable by direct URL**, access code or not.
Do not upload licensed interview guides or anything you do not have the right to
distribute.

---

## The mock log

`roster.html` carries a log of every mock below the rankings: date, member, type,
coach, the easy/medium/hard mix as coloured chips, question count, and that
session's own result. A mock with no hard questions is flagged `no hard`, because
its score is not comparable with one that included them. Filter by member, or
click any row to open that member's profile.

The log's Result column is the score that one session produced. The rankings
above it show the member's running rating across all their mocks, with the
newest weighted 2x.

---

## Page layout note

"How the program runs" and "The rating model" live on **roster.html** (behind the
access code), not on the home page. The home page explains the program in prose
and lists what is included; the detailed scoring mechanics are for members.

// Everything that talks to Jev lives here.
//
// Jev doesn't write text back. You send it a "state" (here: a photo) and a set
// of typed questions, and it returns typed answers:
//   noul   -> probability (0..1) that a yes/no statement is true
//   choice -> which option fits best, plus probabilities for every option
//   score  -> a position along ordered levels you describe
// One request can hold many questions about the same photo, and extra
// questions are cheap, so each photo is analyzed in a single request.

export const SCENES = {
  people: { label: 'People', icon: '👤', text: 'People are the main subject: portraits, selfies, or groups.' },
  pets: { label: 'Pets & animals', icon: '🐾', text: 'Pets or other animals are the main subject.' },
  food: { label: 'Food & drink', icon: '🍽️', text: 'Food or drinks are the main subject.' },
  nature: { label: 'Nature', icon: '🌿', text: 'Landscapes or nature: mountains, sea, sky, forests, plants.' },
  city: { label: 'Places & architecture', icon: '🏙️', text: 'Buildings, streets, landmarks, or rooms as the subject.' },
  documents: { label: 'Documents & screens', icon: '📄', text: 'Documents, receipts, whiteboards, notes, screenshots, or other text-heavy images.' },
  objects: { label: 'Things & products', icon: '📦', text: 'An object or product is the main subject, such as an item for sale or a collection.' },
  vehicles: { label: 'Vehicles', icon: '🚗', text: 'Cars, motorbikes, bicycles, boats, trains, or planes are the main subject.' },
  events: { label: 'Events', icon: '🎉', text: 'An event: a party, wedding, concert, sports match, ceremony, or crowd.' },
  other: { label: 'Other', icon: '✨', text: 'None of the above fits.' },
};

const SETTINGS = {
  indoor: 'Taken indoors.',
  outdoor: 'Taken outdoors.',
  unclear: 'Not a real-world scene, or impossible to tell (for example a screenshot or close-up).',
};

const LIGHT = {
  daylight: 'Natural daylight.',
  golden: 'Warm sunrise or sunset light (golden hour).',
  night: 'Night time or very dark outdoors.',
  artificial: 'Mostly lit by indoor or artificial lights.',
  none: 'No real lighting to judge, such as a screenshot.',
};

const PEOPLE = {
  none: 'No people are visible.',
  one: 'Exactly one person.',
  two: 'Exactly two people.',
  group: 'A small group of three to eight people.',
  crowd: 'A crowd of more than eight people.',
};

export const QUALITY_LEVELS = [
  'Unusable: very blurry, very dark, or clearly an accidental shot.',
  'Poor: noticeably blurry, noisy, tilted, or badly exposed.',
  'Fine: an acceptable everyday photo.',
  'Great: sharp, well exposed, and nicely composed.',
];
export const QUALITY_NAMES = ['Unusable', 'Poor', 'Fine', 'Great'];

// Yes/no tags. Each becomes a tag on a photo when Jev's probability is above
// the threshold in Settings.
export const AUTO_TAGS = [
  { id: 'person', label: 'people', q: 'Is at least one person clearly visible in `photo`?' },
  { id: 'selfie', label: 'selfie', q: 'Is `photo` a selfie, taken by a person of themselves at arm\'s length or in a mirror?' },
  { id: 'child', label: 'kids', q: 'Is a child or baby visible in `photo`?' },
  { id: 'dog', label: 'dog', q: 'Is a dog visible in `photo`?' },
  { id: 'cat', label: 'cat', q: 'Is a cat visible in `photo`?' },
  { id: 'food', label: 'food', q: 'Does `photo` show food or a meal?' },
  { id: 'beach', label: 'beach & water', q: 'Is a beach, the sea, a lake, a river, or a swimming pool visible in `photo`?' },
  { id: 'mountain', label: 'mountains', q: 'Are mountains or hills visible in `photo`?' },
  { id: 'snow', label: 'snow', q: 'Is there snow or ice in `photo`?' },
  { id: 'sunset', label: 'sunset', q: 'Does `photo` show a sunrise or sunset sky?' },
  { id: 'flowers', label: 'flowers & plants', q: 'Are flowers or plants a prominent part of `photo`?' },
  { id: 'vehicle', label: 'vehicles', q: 'Is a car, motorbike, bicycle, boat, train, or plane a prominent part of `photo`?' },
  { id: 'celebration', label: 'celebration', q: 'Does `photo` show a celebration such as a birthday, wedding, holiday, or party?' },
  { id: 'sport', label: 'sports & activity', q: 'Does `photo` show a sport, workout, or outdoor activity such as hiking or cycling?' },
  { id: 'text', label: 'has text', q: 'Does `photo` contain readable text as an important part, such as signs, labels, or pages?' },
  { id: 'screenshot', label: 'screenshot', q: 'Is `photo` a screenshot of a phone or computer screen, rather than a camera photo?' },
  { id: 'receipt', label: 'receipt / document', q: 'Does `photo` show a receipt, invoice, ticket, form, or paper document?' },
  { id: 'whiteboard', label: 'whiteboard / notes', q: 'Does `photo` show a whiteboard, chalkboard, slide, or handwritten notes?' },
  { id: 'sensitive', label: 'sensitive info', q: 'Does `photo` show sensitive information such as a credit card, ID card, passport, password, or bank details?' },
  { id: 'blurry', label: 'blurry', q: 'Is `photo` noticeably blurry or out of focus?' },
  { id: 'eyes_closed', label: 'eyes closed', q: 'Does `photo` show a person whose eyes are closed or mid-blink?' },
];

function baseQuestions() {
  const q = {
    scene: { type: 'choice', instructions: 'What is the main subject of `photo`?', criteria: Object.fromEntries(Object.entries(SCENES).map(([k, v]) => [k, v.text])) },
    setting: { type: 'choice', instructions: 'Where was `photo` taken?', criteria: SETTINGS },
    light: { type: 'choice', instructions: 'What is the lighting in `photo`?', criteria: LIGHT },
    people_count: { type: 'choice', instructions: 'How many people are visible in `photo`?', criteria: PEOPLE },
    quality: { type: 'score', instructions: 'How good is `photo` as a photograph, judged on sharpness, exposure, and composition?', criteria: QUALITY_LEVELS },
  };
  for (const t of AUTO_TAGS) q[`tag_${t.id}`] = { type: 'noul', instructions: t.q };
  return q;
}

// A custom tag can be plain text ("my red bike") or include a reference
// picture from your library ("this is Max"), which Jev compares against.
function customQuestion(tag, path, refId) {
  const desc = tag.description?.trim() ? ` (${tag.description.trim()})` : '';
  const instructions = refId
    ? `Does ${path} show the same ${tag.name}${desc} as this reference picture: ${refId}?`
    : `Does ${path} show ${tag.name}${desc}?`;
  return { type: 'noul', instructions };
}

const newRef = () => `img-${crypto.randomUUID()}`;

// ---------- transport ----------

export class JevError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

let usageListener = () => {};
export function onUsage(fn) { usageListener = fn; }

async function post(body, { apiKey, signal }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Jev-Key'] = apiKey;
  let delay = 1500;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch('/api/jev', { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new JevError('Can\'t reach the Sift server. Is `python3 server.py` still running?', 0);
    }
    // Back off and retry when Jev is busy or rate-limiting.
    if ((res.status === 429 || res.status === 529 || res.status === 502) && attempt < 4) {
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!res.ok) throw new JevError(explain(res.status, data), res.status);
    if (data.usage) usageListener(data.usage);
    return data;
  }
}

function explain(status, data) {
  const detail = data?.error || data?.detail || data?.message;
  const msg = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail).slice(0, 300) : '';
  if (status === 401) return 'Jev rejected the API key. Check it in Settings.';
  if (status === 413) return 'That image was too large for Jev.';
  if (status === 429) return 'Jev rate limit reached. Try again in a minute.';
  return `Jev error ${status}${msg ? `: ${msg}` : ''}`;
}

// ---------- public API ----------

// Analyze one photo: scene, setting, lighting, people, quality, and all tags.
export async function analyzePhoto(copy, { customTags = [], refCopies = {}, model, apiKey, signal }) {
  const ref = newRef();
  const assets = { [ref]: { type: 'image', format: 'jpg', data_base64: copy.base64 } };
  const questions = baseQuestions();
  for (const tag of customTags) {
    let refId;
    if (tag.refPhotoId && refCopies[tag.refPhotoId]) {
      refId = newRef();
      assets[refId] = { type: 'image', format: 'jpg', data_base64: refCopies[tag.refPhotoId].base64 };
    }
    questions[`custom_${tag.id}`] = customQuestion(tag, '`photo`', refId);
  }
  const data = await post({ model, state: { photo: ref }, assets, questions }, { apiKey, signal });
  return { model: data.model, at: Date.now(), answers: data.answers };
}

// Ask the same yes/no question about many photos, a few photos per request.
// `makeQuestion(path)` returns a question about the photo at that state path.
// Calls onProgress(done, total) and returns { photoId: probability }.
// `extraImages` ({ name: copy }) go into the state once per request, so
// questions can point at them by name (e.g. a reference picture).
export async function askAcross(items, makeQuestion, { batchSize = 4, extraImages = {}, model, apiKey, signal, onProgress = () => {}, concurrency = 2 }) {
  const results = {};
  const batches = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));
  let done = 0;
  let next = 0;

  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      const assets = {};
      const refs = batch.map((item) => {
        const r = newRef();
        assets[r] = { type: 'image', format: 'jpg', data_base64: item.base64 };
        return r;
      });
      const state = { photos: refs };
      for (const [name, copy] of Object.entries(extraImages)) {
        const r = newRef();
        assets[r] = { type: 'image', format: 'jpg', data_base64: copy.base64 };
        state[name] = r;
      }
      const questions = {};
      batch.forEach((item, i) => { questions[`q${i}`] = makeQuestion(`\`photos[${i}]\``); });
      const data = await post({ model, state, assets, questions }, { apiKey, signal });
      batch.forEach((item, i) => { results[item.id] = data.answers?.[`q${i}`]?.noul ?? 0; });
      done += batch.length;
      onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return results;
}

export function searchQuestion(query) {
  return (path) => ({
    type: 'noul',
    instructions: `Does ${path} match this photo search: "${query}"?`,
    criteria: {
      true: 'The photo clearly shows what the search describes.',
      false: 'The photo does not show what the search describes, or only very loosely.',
    },
  });
}

// Use with askAcross(..., { extraImages: { reference: copy } }) when the tag
// has a reference picture.
export function customTagQuestion(tag, hasReference) {
  return (path) => customQuestion(tag, path, hasReference ? '`reference`' : undefined);
}

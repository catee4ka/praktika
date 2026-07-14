import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const file = globalThis.process?.env?.DATA_FILE
  ? path.resolve(globalThis.process.env.DATA_FILE)
  : path.join(dir, 'data.json');

const seed = {
  users: [],
  quizzes: [],
  sessions: [],
};

function load() {
  try {
    return { ...seed, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return structuredClone(seed);
  }
}

let data = load();

function persist() {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export const store = {
  get users() { return data.users; },
  get quizzes() { return data.quizzes; },
  get sessions() { return data.sessions; },
  save: persist,
  reset(next = seed) {
    data = structuredClone(next);
    persist();
  },
};

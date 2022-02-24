import { config } from "./config.ts";
import { encoding } from "./deps/encoding_japanese.ts";
import { JpNum } from "./deps/japanese_numeral.ts";
import { zip } from "./deps/std/collections.ts";
import { iter } from "./deps/std/io.ts";
import { Encode } from "./types.ts";
import type { Encoding, SkkServerOptions } from "./types.ts";
import { Cell } from "./util.ts";

const okuriAriMarker = ";; okuri-ari entries.";
const okuriNasiMarker = ";; okuri-nasi entries.";

const lineRegexp = /^(\S+) \/(.*)\/$/;

function toZenkaku(n: number): string {
  return n.toString().replaceAll(/[0-9]/g, (c): string => {
    const zenkakuNumbers = ["０", "１", "２", "３", "４", "５", "６", "７", "８", "９"];
    return zenkakuNumbers[parseInt(c)];
  });
}
function toKanjiModern(n: number): string {
  return n.toString().replaceAll(/[0-9]/g, (c): string => {
    const kanjiNumbers = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    return kanjiNumbers[parseInt(c)];
  });
}
const toKanjiClassic: (n: number) => string = JpNum.number2kanji;

function convertNumber(pattern: string, entry: string): string {
  return zip(pattern.split(/(#[0-9]?)/g), entry.split(/([0-9]+)/g))
    .map(([k, e]) => {
      switch (k) {
        case "#":
        case "#0":
        case "#4":
        case "#5":
        case "#6":
        case "#7":
        case "#8":
        case "#9":
          return e;
        case "#1":
          return toZenkaku(parseInt(e));
        case "#2":
          return toKanjiModern(parseInt(e));
        case "#3":
          return toKanjiClassic(parseInt(e));
        default:
          return k;
      }
    })
    .join("");
}

export interface Dictionary {
  getCandidate(type: HenkanType, word: string): Promise<string[]>;
  getCandidates(prefix: string): Promise<[string, string[]][]>;
}

function encode(str: string, encode: Encoding): Uint8Array {
  const utf8Encoder = new TextEncoder();
  const utf8Bytes = utf8Encoder.encode(str);
  const eucBytesArray = encoding.convert(utf8Bytes, Encode[encode], "UTF8");
  const eucBytes = Uint8Array.from(eucBytesArray);
  return eucBytes;
}

export class NumberConvertWrapper implements Dictionary {
  #inner: Dictionary;

  constructor(dict: Dictionary) {
    this.#inner = dict;
  }

  async getCandidate(type: HenkanType, word: string): Promise<string[]> {
    const realWord = word.replaceAll(/[0-9]+/g, "#");
    const candidate = await this.#inner.getCandidate(type, realWord);
    if (word === realWord) {
      return candidate;
    } else {
      return candidate.map((c) => convertNumber(c, word));
    }
  }

  async getCandidates(prefix: string): Promise<[string, string[]][]> {
    const realPrefix = prefix.replaceAll(/[0-9]+/g, "#");
    const candidates = await this.#inner.getCandidates(realPrefix);
    if (prefix === realPrefix) {
      return candidates;
    } else {
      return candidates.map((
        [kana, cand],
      ) => [kana, cand.map((c) => convertNumber(c, prefix))]);
    }
  }
}

export function wrapDictionary(dict: Dictionary): Dictionary {
  return new NumberConvertWrapper(
    dict,
  );
}

export class SKKDictionary implements Dictionary {
  #okuriAri: Map<string, string[]>;
  #okuriNasi: Map<string, string[]>;

  constructor(
    okuriAri?: Map<string, string[]>,
    okuriNasi?: Map<string, string[]>,
  ) {
    this.#okuriAri = okuriAri ?? new Map();
    this.#okuriNasi = okuriNasi ?? new Map();
  }

  getCandidate(type: HenkanType, word: string): Promise<string[]> {
    const target = type === "okuriari" ? this.#okuriAri : this.#okuriNasi;
    return Promise.resolve(target.get(word) ?? []);
  }

  getCandidates(prefix: string): Promise<[string, string[]][]> {
    const candidates: [string, string[]][] = [];
    for (const entry of this.#okuriNasi) {
      if (entry[0].startsWith(prefix)) {
        candidates.push(entry);
      }
    }
    candidates.sort((a, b) => a[0].localeCompare(b[0]));
    return Promise.resolve(candidates);
  }
}

export function encodeJisyo(jisyo: SKKDictionary) {
  return jisyo.toString();
}

export type HenkanType = "okuriari" | "okurinasi";

function decode(str: Uint8Array, encode: Encoding): string {
  const decoder = new TextDecoder(encode);
  return decoder.decode(str);
}

export class SkkServer implements Dictionary {
  #conn: Deno.Conn | undefined;
  responseEncoding: Encoding;
  requestEncoding: Encoding;
  connectOptions: Deno.ConnectOptions;
  constructor(opts: SkkServerOptions) {
    this.requestEncoding = opts.requestEnc;
    this.responseEncoding = opts.responseEnc;
    this.connectOptions = {
      hostname: opts.hostname,
      port: opts.port,
    };
  }
  async connect() {
    this.#conn = await Deno.connect(this.connectOptions);
  }
  async getCandidate(word: string): Promise<string[]> {
    if (!this.#conn) return [];
    await this.#conn.write(encode(`1${word} `, this.requestEncoding));
    const result: string[] = [];
    for await (const res of iter(this.#conn)) {
      const str = decode(res, this.responseEncoding);
      result.push(...(str.at(0) === "4") ? [] : str.split("/").slice(1, -1));

      if (str.endsWith("\n")) {
        break;
      }
    }
    return result;
  }
  async getCandidates(_prefix: string): Promise<[string, string[]][]> {
    // TODO: add support for ddc.vim
    return await Promise.resolve([["", [""]]]);
  }
  close() {
    this.#conn?.write(encode("0", this.requestEncoding));
    this.#conn?.close();
  }
}

export class Library {
  #globalJisyo: SKKDictionary;
  #userJisyo: SKKDictionary;
  #userJisyoPath: string;
  #userJisyoTimestamp = -1;
  #skkServer: SkkServer | undefined;

  constructor(
    globalJisyo?: SKKDictionary,
    userJisyo?: SKKDictionary,
    userJisyoPath?: string,
    skkServer?: SkkServer,
  ) {
    this.#globalJisyo = globalJisyo ?? new SKKDictionary();
    this.#userJisyo = userJisyo ?? new SKKDictionary();
    this.#userJisyoPath = userJisyoPath ?? "";
    this.#skkServer = skkServer;
  }

  async getCandidate(type: HenkanType, word: string): Promise<string[]> {
    const userCandidates = await this.#userJisyo.getCandidate(type, word);
    const merged = userCandidates.slice();
    const globalCandidates = await this.#globalJisyo.getCandidate(type, word);
    const remoteCandidates = await this.#skkServer?.getCandidate(word);
    if (globalCandidates) {
      for (const c of globalCandidates) {
        if (!merged.includes(c)) {
          merged.push(c);
        }
      }
    }
    if (remoteCandidates) {
      for (const c of remoteCandidates) {
        if (!merged.includes(c)) {
          merged.push(c);
        }
      }
    }
    return merged;
  }

  async getCandidates(prefix: string): Promise<[string, string[]][]> {
    if (prefix.length < 2) {
      return [];
    }
    const candidates = new Map<string, string[]>();
    for (const [key, value] of await this.#userJisyo.getCandidates(prefix)) {
      candidates.set(
        key,
        Array.from(new Set([...candidates.get(key) ?? [], ...value])),
      );
    }
    for (const [key, value] of await this.#globalJisyo.getCandidates(prefix)) {
      candidates.set(
        key,
        Array.from(new Set([...candidates.get(key) ?? [], ...value])),
      );
    }
    return Array.from(candidates.entries());
  }

  async registerCandidate(type: HenkanType, word: string, candidate: string) {
    if (!candidate) {
      return;
    }
    // this.#userJisyo.registerCandidate(type, word, candidate);
    if (config.immediatelyJisyoRW) {
      await this.saveJisyo();
    }
  }

  async loadJisyo() {
    if (this.#userJisyoPath) {
      try {
        const stat = await Deno.stat(this.#userJisyoPath);
        const time = stat.mtime?.getTime() ?? -1;
        if (time === this.#userJisyoTimestamp) {
          return;
        }
        this.#userJisyoTimestamp = time;
        this.#userJisyo = decodeJisyo(
          await Deno.readTextFile(this.#userJisyoPath),
        );
      } catch {
        // do nothing
      }
    }
  }

  async saveJisyo() {
    if (this.#userJisyoPath) {
      try {
        await Deno.writeTextFile(
          this.#userJisyoPath,
          encodeJisyo(this.#userJisyo),
        );
      } catch {
        console.log(
          `warning(skkeleton): can't write userJisyo to ${this.#userJisyoPath}`,
        );
        return;
      }
      const stat = await Deno.stat(this.#userJisyoPath);
      const time = stat.mtime?.getTime() ?? -1;
      this.#userJisyoTimestamp = time;
    }
  }
}

export function decodeJisyo(data: string): SKKDictionary {
  const lines = data.split("\n");

  const okuriAriIndex = lines.indexOf(okuriAriMarker);
  const okuriNasiIndex = lines.indexOf(okuriNasiMarker);

  const okuriAriEntries = lines.slice(okuriAriIndex + 1, okuriNasiIndex).map(
    (s) => s.match(lineRegexp),
  ).filter((m) => m).map((m) =>
    [m![1], m![2].split("/")] as [string, string[]]
  );
  const okuriNasiEntries = lines.slice(okuriNasiIndex + 1, lines.length).map(
    (s) => s.match(lineRegexp),
  ).filter((m) => m).map((m) =>
    [m![1], m![2].split("/")] as [string, string[]]
  );

  return new SKKDictionary(
    new Map(okuriAriEntries),
    new Map(okuriNasiEntries),
  );
}

/**
 * load SKK jisyo from `path`
 */
export async function loadJisyo(
  path: string,
  jisyoEncoding: string,
): Promise<SKKDictionary> {
  const decoder = new TextDecoder(jisyoEncoding);
  return decodeJisyo(decoder.decode(await Deno.readFile(path)));
}

function linesToString(entries: [string, string[]][]): string[] {
  return entries.sort((a, b) => a[0].localeCompare(b[0])).map((entry) =>
    `${entry[0]} /${entry[1].join("/")}/`
  );
}

export function ensureJisyo(x: unknown): asserts x is Dictionary {
  if (x instanceof SKKDictionary) {
    return;
  }
  throw new Error("corrupt jisyo detected");
}

export async function load(
  globalJisyoPath: string,
  userJisyoPath: string,
  jisyoEncoding = "euc-jp",
  skkServer?: SkkServer,
): Promise<Library> {
  let globalJisyo = new SKKDictionary();
  let userJisyo = new SKKDictionary();
  try {
    globalJisyo = await loadJisyo(
      globalJisyoPath,
      jisyoEncoding,
    );
  } catch (e) {
    console.error("globalJisyo loading failed");
    console.error(`at ${globalJisyoPath}`);
    if (config.debug) {
      console.error(e);
    }
  }
  try {
    userJisyo = await loadJisyo(
      userJisyoPath,
      "utf-8",
    );
  } catch (e) {
    if (config.debug) {
      console.log("userJisyo loading failed");
      console.log(e);
    }
    // do nothing
  }
  try {
    if (skkServer) {
      skkServer.connect();
    }
  } catch (e) {
    if (config.debug) {
      console.log("connecting to skk server is failed");
      console.log(e);
    }
  }
  return new Library(globalJisyo, userJisyo, userJisyoPath, skkServer);
}

export const currentLibrary = new Cell(() => new Library());

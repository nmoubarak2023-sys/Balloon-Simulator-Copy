const constructors = {
  Float32Array,
  Float64Array,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
};
export function createProcessCodec(initial = {}) {
  const assets = new Map(Object.entries(initial));
  const cache = new WeakMap();
  async function encode(value) {
    if (value === undefined) return { $undefined: true };
    if (value === null || typeof value !== "object") return value;
    if (ArrayBuffer.isView(value)) {
      let id = cache.get(value);
      if (!id) {
        const bytes = new Uint8Array(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        );
        const hash = new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes),
        );
        id =
          value.constructor.name +
          "-" +
          Array.from(hash, (v) => v.toString(16).padStart(2, "0")).join("");
        if (!assets.has(id)) {
          let binary = "";
          for (let start = 0; start < bytes.length; start += 32768)
            binary += String.fromCharCode(
              ...bytes.subarray(start, start + 32768),
            );
          assets.set(id, { type: value.constructor.name, data: btoa(binary) });
        }
        cache.set(value, id);
      }
      return { $asset: id };
    }
    if (value instanceof Map)
      return {
        $map: await Promise.all(
          [...value].map(async ([k, v]) => [await encode(k), await encode(v)]),
        ),
      };
    if (Array.isArray(value)) return Promise.all(value.map(encode));
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      result[key] = await encode(item);
    }
    return result;
  }
  const decoded = new Map();
  function decode(value) {
    if (!value || typeof value !== "object") return value;
    if (value.$undefined) return undefined;
    if (value.$asset) {
      if (!decoded.has(value.$asset)) {
        const asset = assets.get(value.$asset);
        if (!asset || !constructors[asset.type])
          throw Error("Build script has a missing or invalid geometry asset.");
        const bytes = Uint8Array.from(atob(asset.data), (c) => c.charCodeAt(0));
        decoded.set(value.$asset, new constructors[asset.type](bytes.buffer));
      }
      return decoded.get(value.$asset);
    }
    if (value.$map)
      return new Map(value.$map.map(([k, v]) => [decode(k), decode(v)]));
    if (Array.isArray(value)) return value.map(decode);
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => !["__proto__", "constructor", "prototype"].includes(key),
        )
        .map(([k, v]) => [k, decode(v)]),
    );
  }
  return { encode, decode, assets: () => Object.fromEntries(assets) };
}
export function validateBuildScript(data) {
  if (
    data?.format !== "balloon-build-script" ||
    data.version !== 1 ||
    !Array.isArray(data.steps) ||
    !data.steps.length ||
    !data.assets ||
    data.steps.some(
      (step) =>
        !step.view ||
        !Number.isFinite(step.time) ||
        typeof step.label !== "string",
    )
  )
    throw Error("Choose a valid Balloon Build script.");
  return data;
}

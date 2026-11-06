export class GeometryHistory {
  constructor(limit = 20) {
    this.limit = limit;
    this.past = [];
  }
  commit(previous, next, label) {
    if (previous.boundary) {
      this.past.push({ state: previous, label });
      if (this.past.length > this.limit) this.past.shift().state.clear();
    } else previous.clear();
    return next;
  }
  undo(current) {
    if (!this.past.length) throw Error("There is no model action to undo.");
    const entry = this.past.pop();
    current.clear();
    return entry.state;
  }
  replace(current, next) {
    current.clear();
    this.clear();
    return next;
  }
  clear() {
    for (const entry of this.past) entry.state.clear();
    this.past = [];
  }
}
export class UndoJournal {
  constructor(limit = 20) {
    this.limit = limit;
    this.entries = [];
  }
  push(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
  }
  peek() {
    return this.entries.at(-1);
  }
  pop() {
    return this.entries.pop();
  }
  get length() {
    return this.entries.length;
  }
}
export function isUndoShortcut(event) {
  if (
    !(event.ctrlKey || event.metaKey) ||
    event.altKey ||
    event.shiftKey ||
    event.key?.toLowerCase() !== "z"
  )
    return false;
  const t = event.target,
    tag = t?.tagName?.toLowerCase();
  return !(
    t?.isContentEditable ||
    tag === "textarea" ||
    (tag === "input" &&
      !["range", "checkbox", "radio", "button", "submit"].includes(t.type))
  );
}

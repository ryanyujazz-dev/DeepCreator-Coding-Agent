type Field = "title" | "markdown";

export type PlanStreamUpdate = {
  markdownDelta?: string;
  title?: string;
};

function decodedEscape(value: string): string {
  return ({
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t"
  } as Record<string, string>)[value] ?? value;
}

/** Incrementally decodes the two string fields exposed by submit_plan. */
export class PlanArgumentStream {
  private state: "key" | "colon" | "value" | "comma" = "key";
  private stringRole: "key" | "value" | null = null;
  private token = "";
  private currentKey = "";
  private escaping = false;
  private unicode = "";
  private title = "";
  private markdown = "";
  private emittedMarkdownLength = 0;
  private emittedTitle = "";

  push(chunk: string): PlanStreamUpdate {
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index];
      if (this.stringRole) {
        if (this.unicode) {
          if (/^[0-9a-f]$/i.test(character)) {
            this.unicode += character;
            if (this.unicode.length === 5) {
              this.append(String.fromCharCode(Number.parseInt(this.unicode.slice(1), 16)));
              this.unicode = "";
              this.escaping = false;
            }
            continue;
          }
          this.append("u");
          this.unicode = "";
          this.escaping = false;
        }
        if (this.escaping) {
          if (character === "u") this.unicode = "u";
          else {
            this.append(decodedEscape(character));
            this.escaping = false;
          }
          continue;
        }
        if (character === "\\") {
          this.escaping = true;
          continue;
        }
        if (character === '"') {
          this.finishString();
          continue;
        }
        this.append(character);
        continue;
      }

      if (/\s/.test(character) || character === "{") continue;
      if (this.state === "key" && character === '"') {
        this.stringRole = "key";
        this.token = "";
      } else if (this.state === "colon" && character === ":") {
        this.state = "value";
      } else if (this.state === "value" && character === '"') {
        this.stringRole = "value";
        this.token = "";
      } else if (this.state === "comma" && character === ",") {
        this.state = "key";
      }
    }

    const update: PlanStreamUpdate = {};
    const visibleTitle = this.valueFor("title");
    const visibleMarkdown = this.valueFor("markdown");
    if (visibleTitle !== this.emittedTitle) {
      this.emittedTitle = visibleTitle;
      update.title = visibleTitle;
    }
    if (visibleMarkdown.length > this.emittedMarkdownLength) {
      update.markdownDelta = visibleMarkdown.slice(this.emittedMarkdownLength);
      this.emittedMarkdownLength = visibleMarkdown.length;
    }
    return update;
  }

  private append(value: string): void {
    this.token += value;
    if (this.stringRole !== "value") return;
    if (this.currentKey === "title") this.title = this.token;
    if (this.currentKey === "markdown") this.markdown = this.token;
  }

  private finishString(): void {
    if (this.stringRole === "key") {
      this.currentKey = this.token;
      this.state = "colon";
    } else {
      if (this.currentKey === "title") this.title = this.token;
      if (this.currentKey === "markdown") this.markdown = this.token;
      this.state = "comma";
    }
    this.stringRole = null;
    this.token = "";
  }

  private valueFor(field: Field): string {
    if (this.stringRole === "value" && this.currentKey === field) return this.token;
    return field === "title" ? this.title : this.markdown;
  }
}

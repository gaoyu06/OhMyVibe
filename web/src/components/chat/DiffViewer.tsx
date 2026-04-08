import { GitCommitHorizontal } from "lucide-react";

export default function DiffViewer({ text }: { text: string }) {
  const sections = parseDiffSections(text);

  return (
    <div className="divide-y divide-border">
      {sections.map((section, index) => (
        <div key={`${section.path}-${index}`} className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium">
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            <span className="truncate">{section.path || `Change ${index + 1}`}</span>
          </div>
          <div className="font-mono text-xs leading-5">
            {section.lines.map((line, lineIndex) => (
              <div key={`${section.path}-${lineIndex}`} className={getDiffLineClassName(line)}>
                <span className="select-none pr-3 text-[10px] text-muted-foreground/70">{lineIndex + 1}</span>
                <span className="whitespace-pre-wrap break-words">{line || " "}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function parseDiffSections(text: string) {
  const lines = String(text || "").split(/\r?\n/);
  const sections: Array<{ path: string; lines: string[] }> = [];
  let current: { path: string; lines: string[] } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = {
        path: match?.[2] || match?.[1] || line,
        lines: [line],
      };
      sections.push(current);
      continue;
    }

    if (!current) {
      const nextLine = lines[index + 1] ?? "";
      if (line && !isDiffLine(line) && (isDiffLine(nextLine) || nextLine.startsWith("diff --git "))) {
        current = { path: line, lines: [] };
        sections.push(current);
        continue;
      }
      current = { path: "output", lines: [] };
      sections.push(current);
    }

    current.lines.push(line);
  }

  return sections.filter((section) => section.lines.length || section.path);
}

function isDiffLine(line: string) {
  return (
    line.startsWith("@@") ||
    line.startsWith("+") ||
    line.startsWith("-") ||
    line.startsWith(" ") ||
    line.startsWith("---") ||
    line.startsWith("+++") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode")
  );
}

function getDiffLineClassName(line: string) {
  if (line.startsWith("@@")) {
    return "grid grid-cols-[auto_1fr] gap-0 border-b border-border/60 bg-blue-500/8 px-3 py-1 text-blue-700 dark:text-blue-300";
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "grid grid-cols-[auto_1fr] gap-0 bg-emerald-500/10 px-3 py-1 text-emerald-700 dark:text-emerald-300";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "grid grid-cols-[auto_1fr] gap-0 bg-red-500/10 px-3 py-1 text-red-700 dark:text-red-300";
  }
  return "grid grid-cols-[auto_1fr] gap-0 px-3 py-1";
}

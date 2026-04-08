import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";

export default function ProjectCodeEditor({
  path,
  value,
  theme,
  onChange,
  onSelectionChange,
}: {
  path: string;
  value: string;
  theme: "light" | "dark";
  onChange: (value: string) => void;
  onSelectionChange: (value: string) => void;
}) {
  const [extensions, setExtensions] = useState<Extension[]>([EditorView.lineWrapping]);

  useEffect(() => {
    let cancelled = false;

    const loadLanguage = async () => {
      const nextExtensions: Extension[] = [EditorView.lineWrapping];
      const extension = pathLikeExtension(path);
      let language: Extension | null = null;

      if (extension === "tsx") {
        const { javascript } = await import("@codemirror/lang-javascript");
        language = javascript({ typescript: true, jsx: true });
      } else if (extension === "ts") {
        const { javascript } = await import("@codemirror/lang-javascript");
        language = javascript({ typescript: true });
      } else if (extension === "jsx") {
        const { javascript } = await import("@codemirror/lang-javascript");
        language = javascript({ jsx: true });
      } else if (extension === "js" || extension === "mjs" || extension === "cjs") {
        const { javascript } = await import("@codemirror/lang-javascript");
        language = javascript();
      } else if (extension === "json") {
        const { json } = await import("@codemirror/lang-json");
        language = json();
      } else if (extension === "md" || extension === "mdx") {
        const { markdown } = await import("@codemirror/lang-markdown");
        language = markdown();
      } else if (extension === "css" || extension === "scss" || extension === "less") {
        const { css } = await import("@codemirror/lang-css");
        language = css();
      } else if (extension === "html" || extension === "htm") {
        const { html } = await import("@codemirror/lang-html");
        language = html();
      } else if (extension === "xml" || extension === "svg") {
        const { xml } = await import("@codemirror/lang-xml");
        language = xml();
      } else if (extension === "py") {
        const { python } = await import("@codemirror/lang-python");
        language = python();
      }

      if (language) {
        nextExtensions.push(language);
      }

      if (!cancelled) {
        setExtensions(nextExtensions);
      }
    };

    void loadLanguage();

    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="project-code-editor h-full min-h-full">
      <CodeMirror
        value={value}
        height="100%"
        width="100%"
        theme={theme === "dark" ? oneDark : "light"}
        basicSetup={{
          foldGutter: true,
          lineNumbers: true,
          highlightActiveLine: true,
          highlightSelectionMatches: true,
          indentOnInput: true,
        }}
        extensions={extensions}
        onChange={onChange}
        onUpdate={(update) => {
          if (!update.selectionSet) {
            return;
          }
          const range = update.state.selection.main;
          onSelectionChange(range.empty ? "" : update.state.sliceDoc(range.from, range.to));
        }}
      />
    </div>
  );
}

function pathLikeExtension(filePath: string) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const lastSegment = normalized.split("/").pop() || "";
  const parts = lastSegment.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
}

import React, { useState } from "react";
import Editor from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { usePostHog } from "posthog-js/react";
import { Check, Copy } from "lucide-react";
import { FeatureFile } from "@/types/feature";
interface CodeEditorProps {
  file?: FeatureFile;
  onFileChange?: (fileName: string, content: string) => void;
}

export function CodeEditor({ file, onFileChange }: CodeEditorProps) {
  const handleEditorChange = (value: string | undefined) => {
    if (value && onFileChange) {
      onFileChange(file!.name, value);
    }
  };

  const { forcedTheme, resolvedTheme } = useTheme();
  const currentTheme = forcedTheme || resolvedTheme;
  const posthog = usePostHog();
  const [copied, setCopied] = useState(false);

  // NOTE (PNI-272): kept verbatim. Monaco wants "typescript" where the feature
  // files say "ts". Deriving a local instead would stop mutating the caller's
  // object, which is a behaviour change; this branch is byte-for-byte as before.
  // eslint-disable-next-line react-hooks/immutability
  if (file?.language === "ts") file.language = "typescript";

  const handleCopy = async () => {
    if (!file?.content) return;
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      posthog?.capture("dojo.code_viewer.copied", {
        file_name: file.name,
        language: file.language,
        bytes: file.content.length,
      });
    } catch {
      // Clipboard write can fail in insecure contexts or denied permissions.
      // Silent no-op is acceptable — the user will retry or copy manually.
    }
  };

  return file ? (
    <div className="h-full flex flex-col relative">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy code"}
        className="absolute top-2 right-4 z-10 flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-gray-200 dark:border-neutral-700 bg-white/80 dark:bg-neutral-900/80 text-gray-700 dark:text-neutral-200 hover:bg-white dark:hover:bg-neutral-800 transition-colors"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
      <Editor
        height="100%"
        language={file.language}
        value={file.content}
        onChange={handleEditorChange}
        options={{
          minimap: { enabled: false },
          padding: { top: 30, bottom: 30 },
          fontSize: 16,
          lineNumbers: "on",
          readOnly: true,
          wordWrap: "on",
          stickyScroll: {
            enabled: false,
          },
        }}
        theme={currentTheme !== "dark" ? "light" : "vs-dark"}
      />
    </div>
  ) : (
    <div className="p-6 text-center text-muted-foreground">
      Select a file from the file tree to view its code
    </div>
  );
}

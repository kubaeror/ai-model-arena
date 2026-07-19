import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';

interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** language hint: js | json | md | text */
  language?: 'js' | 'json' | 'md' | 'text';
  height?: string;
}

export function CodeEditor({ value, onChange, readOnly = false, language = 'js', height = '300px' }: CodeEditorProps) {
  const extensions = useMemo(() => {
    if (language === 'js' || language === 'json') return [javascript({ jsx: false, typescript: false })];
    return [];
  }, [language]);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-[#1e293b]">
      <CodeMirror
        value={value}
        height={height}
        theme="dark"
        readOnly={readOnly}
        extensions={extensions}
        onChange={(val) => onChange?.(val)}
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: !readOnly }}
      />
    </div>
  );
}

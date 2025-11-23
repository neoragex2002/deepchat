import { h } from 'vue'
// Preload Monaco language contributions along with VRM setup (inlined)
// Full languages with workers
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution'
import 'monaco-editor/esm/vs/language/json/monaco.contribution'
import 'monaco-editor/esm/vs/language/html/monaco.contribution'
import 'monaco-editor/esm/vs/language/css/monaco.contribution'
// Basic languages
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution'
import 'monaco-editor/esm/vs/basic-languages/less/less.contribution'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution'
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution'
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution'
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution'
import 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution'
import 'monaco-editor/esm/vs/basic-languages/swift/swift.contribution'
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution'
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution'
import {
  CodeBlockNode,
  MermaidBlockNode,
  ReferenceNode,
  setCustomComponents
} from 'vue-renderer-markdown'
import { useThemeStore } from '@/stores/theme'
import { useArtifactStore } from '@/stores/artifact'
import { usePresenter } from '@/composables/usePresenter'
import { useReferenceStore } from '@/stores/reference'
import { nanoid } from 'nanoid'

// Register VRM custom components once at app start.
// The callbacks read stores lazily at render-time, so this module can be imported early.

let initialized = false
export function initVrmCustomComponents() {
  if (initialized) return

  setCustomComponents({
    reference: (_props: any) => {
      const threadPresenter = usePresenter('threadPresenter')
      const referenceStore = useReferenceStore()
      return h(ReferenceNode, {
        ..._props,
        onClick() {
          threadPresenter.getSearchResults(_props.messageId ?? '').then((results) => {
            const index = parseInt(_props.node.id)
            if (index < results.length) {
              window.open(results[index - 1].url, '_blank', 'noopener,noreferrer')
            }
          })
        },
        onMouseEnter(ev: MouseEvent) {
          referenceStore.hideReference()
          threadPresenter.getSearchResults(_props.messageId ?? '').then((results) => {
            const index = parseInt(_props.node.id)
            const el = (ev?.currentTarget as HTMLElement) || null
            const rect = el?.getBoundingClientRect()
            if (index - 1 < results.length && rect) {
              referenceStore.showReference(results[index - 1], rect)
            }
          })
        },
        onMouseLeave() {
          referenceStore.hideReference()
        }
      })
    },
    mermaid: (_props: any) => {
      const themeStore = useThemeStore()
      return h(MermaidBlockNode, {
        ..._props,
        isDark: themeStore.isDark,
        node: _props.node
      })
    },
    code_block: (_props: any) => {
      const themeStore = useThemeStore()
      const artifactStore = useArtifactStore()
      return h(CodeBlockNode, {
        ..._props,
        isDark: themeStore.isDark,
        onPreviewCode(v: any) {
          artifactStore.showArtifact(
            {
              id: v.id ?? `vrm-${nanoid()}`,
              type: v.artifactType,
              title: v.artifactTitle,
              language: v.language,
              content: v.node.code,
              status: 'loaded'
            },
            _props.messageId,
            _props.threadId
          )
        }
      })
    }
  })

  initialized = true
}

// Initialize immediately on import
initVrmCustomComponents()

<!-- eslint-disable vue/no-v-html -->
<template>
  <div class="prose prose-sm dark:prose-invert w-full max-w-none break-all">
    <NodeRenderer
      :key="themeStore.isDark ? 'dark' : 'light'"
      :content="renderContent"
      :message-id="messageId"
      :thread-id="threadId"
      @click="onContainerClick"
      @copy="$emit('copy', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { useThemeStore } from '@/stores/theme'
import NodeRenderer from 'vue-renderer-markdown'
import { defineEmits } from 'vue'
import { nanoid } from 'nanoid'
import { computed } from 'vue'
import { usePresenter } from '@/composables/usePresenter'
import { openExternalSafe } from '@/lib/openExternal'
// VRM 自定义组件已在全局模块 src/renderer/src/lib/vrm-init.ts 中注册

const props = defineProps<{
  content: string
  debug?: boolean
  messageId?: string
  threadId?: string
}>()

const themeStore = useThemeStore()

// Provide stable ids for preview/reference within this message scope.
// Prefer caller-provided IDs (real message/thread) and fallback to random.
const messageId = props.messageId || `artifact-msg-${nanoid()}`
const threadId = props.threadId || `artifact-thread-${nanoid()}`
// Fallback click handler: handle reference clicks at container level
// to avoid relying on per-id VRM component mappings.
const threadPresenter = usePresenter('threadPresenter')
const onContainerClick = (ev: MouseEvent) => {
  // Prefer direct match on the rendered reference span for robustness.
  const refEl = (ev.target as HTMLElement | null)?.closest('.reference-node') as
    | HTMLElement
    | null
  if (!refEl) return
  const id = (refEl.textContent || '').trim()
  const index = parseInt(id, 10)
  if (!Number.isFinite(index) || index <= 0) return
  const mid = messageId
  if (!mid) return
  threadPresenter.getSearchResults(mid).then((results: any[]) => {
    if (!Array.isArray(results) || index > results.length) return
    const url = (results[index - 1]?.url || '') as string
    openExternalSafe(url)
  })
}

// Minimal display-layer preprocessing:
// Insert a space between adjacent numeric references to ensure [1][2][3]
// is parsed as three references, not a single link-ref + one reference.
// Avoid touching fenced code blocks and inline code.
const renderContent = computed(() => {
  if (!props.content) return ''
  const lines = props.content.split('\n')
  let inFence = false
  const fenced = lines.map((line) => {
    // Toggle on fenced code blocks ```
    if (line.trim().startsWith('```')) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    // Protect inline code by splitting on backticks
    const parts = line.split('`')
    for (let i = 0; i < parts.length; i += 2) {
      // Only transform non-inline-code segments (even indices)
      parts[i] = parts[i].replace(/(\[\d+\])(\[\d+\])/g, '$1 $2')
    }
    return parts.join('`')
  })
  return fenced.join('\n')
})
defineEmits(['copy'])
</script>

<style lang="css">
.prose {
  pre {
    margin-top: 0;
    margin-bottom: 0;
  }
  .mermaid-block-header img {
    margin: 0 !important;
  }
  li p {
    @apply py-0 my-0;
  }

  hr {
    margin-block-start: 0.5em;
    margin-block-end: 0.5em;
    margin-inline-start: auto;
    margin-inline-end: auto;
  }

  /*
    精准定位到那个被错误地渲染在 <a> 标签内部的 <div>，
    并强制其以行内方式显示，从而修正换行 bug。
    这可以保留链接组件原有的所有样式（包括颜色）。
  */
  a .markdown-renderer {
    @apply inline;
  }
}
</style>

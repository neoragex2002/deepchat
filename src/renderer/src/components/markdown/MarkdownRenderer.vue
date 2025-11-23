<!-- eslint-disable vue/no-v-html -->
<template>
  <div class="prose prose-sm dark:prose-invert w-full max-w-none break-all">
    <NodeRenderer
      :key="themeStore.isDark ? 'dark' : 'light'"
      :content="content"
      :message-id="messageId"
      :thread-id="threadId"
      @copy="$emit('copy', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { useThemeStore } from '@/stores/theme'
import NodeRenderer from 'vue-renderer-markdown'
import { defineEmits } from 'vue'
import { nanoid } from 'nanoid'
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

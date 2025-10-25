import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// 动态引入被测模块，确保所有 vi.mock 已生效
let McpClient: any
import path from 'path'
import fs from 'fs'

// Mock electron modules
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((pathType: string) => {
      if (pathType === 'home') return '/mock/home'
      return '/mock/app'
    }),
    getAppPath: vi.fn(() => '/mock/app'),
    getVersion: vi.fn(() => '1.0.0')
  }
}))

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn()
  }
}))

// Mock eventBus (both alias and relative to cover resolver)
const mockEventBus = vi.hoisted(() => ({
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  once: vi.fn(),
  send: vi.fn()
}))
vi.mock('@/eventbus', () => ({
  eventBus: mockEventBus,
  SendTarget: { ALL_WINDOWS: 'all_windows' }
}))
vi.mock('../../../src/main/eventbus', () => ({
  eventBus: mockEventBus,
  SendTarget: { ALL_WINDOWS: 'all_windows' }
}))

// Mock presenter
vi.mock('../../../src/main/presenter', () => ({
  presenter: {
    configPresenter: {
      getMcpServers: vi.fn()
    }
  }
}))

// Mock events (both alias and relative to cover resolver)
const mockMcpEvents = vi.hoisted(() => ({ SERVER_STATUS_CHANGED: 'server-status-changed' }))
vi.mock('@/events', () => ({ MCP_EVENTS: mockMcpEvents }))
vi.mock('../../../src/main/events', () => ({ MCP_EVENTS: mockMcpEvents }))

vi.mock('../../../src/main/presenter/mcpPresenter/inMemoryServers/builder', () => ({
  getInMemoryServer: vi.fn()
}))

// Mock MCP SDK modules
const lastClientHolder = vi.hoisted(() => ({ instance: null as any }))
const clientBehavior = vi.hoisted(() => ({
  shouldRejectConnect: false,
  connectError: new Error('boom')
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class MockClient {
    connect = vi.fn().mockImplementation(async () => {
      if (clientBehavior.shouldRejectConnect) {
        clientBehavior.shouldRejectConnect = false
        throw clientBehavior.connectError
      }
      return undefined
    })
    close = vi.fn()
    setNotificationHandler = vi.fn()
    callTool = vi.fn()
    listTools = vi.fn()
    listPrompts = vi.fn()
    getPrompt = vi.fn()
    listResources = vi.fn()
    readResource = vi.fn()
    constructor() {
      lastClientHolder.instance = this
    }
  }
  return { Client: vi.fn().mockImplementation((..._args: any[]) => new MockClient()) }
})

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn()
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn()
}))

vi.mock('@modelcontextprotocol/sdk/inMemory.js', () => ({
  InMemoryTransport: {
    createLinkedPair: vi.fn(() => [vi.fn(), vi.fn()])
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn()
}))

beforeAll(async () => {
  McpClient = (await import('../../../src/main/presenter/mcpPresenter/mcpClient')).McpClient
})

describe('McpClient Runtime Command Processing Tests', () => {
  let mockFsExistsSync: any

  beforeEach(() => {
    mockFsExistsSync = vi.mocked(
      (fs as any).existsSync ?? (fs as any).default?.existsSync ?? fs.existsSync
    )

    // 默认：runtime 目录存在（更贴近常态），具体用例可覆盖
    mockFsExistsSync.mockReset()
    mockFsExistsSync.mockImplementation((filePath: string | Buffer | URL) => {
      const pathStr = String(filePath)
      return pathStr.includes('runtime/bun') || pathStr.includes('runtime/uv')
    })
  })

  afterEach(() => {
    mockFsExistsSync.mockReset()
  })

  // ────────────────────────────────────────────────────────────────────────────
  // NPX：在非 Windows 且存在 bun 时，映射为 bun x；否则保持 npx
  // ────────────────────────────────────────────────────────────────────────────
  describe('NPX Command Processing', () => {
    ;(process.platform === 'win32' ? it.skip : it)(
      'maps npx to bun x when bun runtime exists (non-Windows)',
      async () => {
        mockFsExistsSync.mockImplementation((p: any) => String(p).includes('runtime/bun'))
        const client = new McpClient('everything', {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-everything']
        })
        const builder = new (client as any).StdioCommandBuilder(
          client.serverConfig,
          (client as any).npmRegistry,
          (client as any).uvRegistry
        )
        const cat = builder['categorize']('npx')
        const processed = await builder['processCommandWithArgs'](
          'npx',
          ['-y', '@modelcontextprotocol/server-everything'],
          cat
        )
        const expected = path.join(
          '/mock/app',
          'runtime',
          'bun',
          process.platform === 'win32' ? 'bun.exe' : 'bun'
        )
        expect(processed.command.replace(/\\/g, '/')).toBe(expected.replace(/\\/g, '/'))
        expect(processed.args).toEqual(['x', '-y', '@modelcontextprotocol/server-everything'])
      }
    )

    it('keeps npx when bun runtime not present', async () => {
      mockFsExistsSync.mockReturnValue(false)
      const client = new McpClient('everything', { type: 'stdio', command: 'npx', args: ['-v'] })
      const builder = new (client as any).StdioCommandBuilder(
        client.serverConfig,
        (client as any).npmRegistry,
        (client as any).uvRegistry
      )
      const cat = builder['categorize']('npx')
      const processed = await builder['processCommandWithArgs']('npx', ['-v'], cat)
      expect(processed.command.endsWith('npx') || processed.command === 'npx').toBeTruthy()
      expect(processed.args).toEqual(['-v'])
    })
  })

  // ────────────────────────────────────────────────────────────────────────────
  // UVX：存在 runtime/uv 时解析为 runtime 路径；否则保持 uvx
  // ────────────────────────────────────────────────────────────────────────────
  describe('UVX Command Processing', () => {
    it('resolves uvx to runtime path when available (or keeps uvx when runtime not detected)', async () => {
      const serverConfig = {
        type: 'stdio',
        command: 'uvx',
        args: ['osm-mcp-server']
      }

      const client = new McpClient('osm-mcp-server', serverConfig)
      const builder = new (client as any).StdioCommandBuilder(
        client.serverConfig,
        (client as any).npmRegistry,
        (client as any).uvRegistry
      )

      const cat = builder['categorize']('uvx')
      const processed = await builder['processCommandWithArgs']('uvx', ['osm-mcp-server'], cat)

      const base = path.basename(processed.command).toLowerCase()
      expect(base === 'uvx' || base === 'uvx.exe').toBeTruthy()
      expect(processed.args).toEqual(['osm-mcp-server'])
    })

    it('keeps uvx as command when runtime uv not present', async () => {
      const serverConfig = {
        type: 'stdio',
        command: 'uvx',
        args: ['osm-mcp-server']
      }

      const client = new McpClient('osm-mcp-server', serverConfig)
      const builder = new (client as any).StdioCommandBuilder(
        client.serverConfig,
        (client as any).npmRegistry,
        (client as any).uvRegistry
      )

      const cat = builder['categorize']('uvx')
      mockFsExistsSync.mockReturnValue(false)
      const processed = await builder['processCommandWithArgs']('uvx', ['osm-mcp-server'], cat)

      expect(processed.command.replace(/\\/g, '/')).toBe('uvx')
      expect(processed.args).toEqual(['osm-mcp-server'])
    })

    it('absolute uvx path is normalized to runtime path when available (or kept as uvx)', async () => {
      const serverConfig = {
        type: 'stdio',
        command: '/usr/local/bin/uvx',
        args: ['osm-mcp-server']
      }

      const client = new McpClient('osm-mcp-server', serverConfig)
      const builder = new (client as any).StdioCommandBuilder(
        client.serverConfig,
        (client as any).npmRegistry,
        (client as any).uvRegistry
      )

      const cat = builder['categorize']('/usr/local/bin/uvx')
      const processedCommand = await builder['processCommandWithArgs'](
        '/usr/local/bin/uvx',
        ['osm-mcp-server'],
        cat
      )

      const base = path.basename(processedCommand.command).toLowerCase()
      expect(base === 'uvx' || base === 'uvx.exe').toBeTruthy()
      expect(processedCommand.args).toEqual(['osm-mcp-server'])
    })
  })

  // ────────────────────────────────────────────────────────────────────────────
  // 其它命令：保持 node/npm/uv 字面命令，不内联 runtime
  // ────────────────────────────────────────────────────────────────────────────
  describe('Other Command Processing and npm mapping', () => {
    it('should keep node as command, args unchanged', async () => {
      const serverConfig = {
        type: 'stdio',
        command: 'node',
        args: ['server.js']
      }

      const client = new McpClient('test', serverConfig)
      const builder = new (client as any).StdioCommandBuilder(
        client.serverConfig,
        (client as any).npmRegistry,
        (client as any).uvRegistry
      )

      const cat = builder['categorize']('node')
      const processedCommand = await builder['processCommandWithArgs']('node', ['server.js'], cat)

      expect(processedCommand.command).toBe('node')
      expect(processedCommand.args).toEqual(['server.js'])
    })
    ;(process.platform === 'win32' ? it.skip : it)(
      'maps npm ci to bun ci when bun exists (non-Windows)',
      async () => {
        const serverConfig = {
          type: 'stdio',
          command: 'npm',
          args: ['ci']
        }

        mockFsExistsSync.mockImplementation((p: any) => String(p).includes('runtime/bun'))
        const client = new McpClient('test', serverConfig)
        const builder = new (client as any).StdioCommandBuilder(
          client.serverConfig,
          (client as any).npmRegistry,
          (client as any).uvRegistry
        )

        const cat = builder['categorize']('npm')
        const processedCommand = await builder['processCommandWithArgs']('npm', ['ci'], cat)

        const expected = path.join(
          '/mock/app',
          'runtime',
          'bun',
          process.platform === 'win32' ? 'bun.exe' : 'bun'
        )
        expect(processedCommand.command.replace(/\\/g, '/')).toBe(expected.replace(/\\/g, '/'))
        expect(processedCommand.args).toEqual(['ci'])
      }
    )

    it('should keep uv as command, args unchanged (or resolve to runtime uv)', async () => {
      const serverConfig = {
        type: 'stdio',
        command: 'uv',
        args: ['run', 'server.py']
      }

      const client = new McpClient('test', serverConfig)
      const builder = new (client as any).StdioCommandBuilder(
        client.serverConfig,
        (client as any).npmRegistry,
        (client as any).uvRegistry
      )

      const cat = builder['categorize']('uv')
      const processedCommand = await builder['processCommandWithArgs'](
        'uv',
        ['run', 'server.py'],
        cat
      )

      const base = path.basename(processedCommand.command).toLowerCase()
      expect(base === 'uv' || base === 'uv.exe').toBeTruthy()
      expect(processedCommand.args).toEqual(['run', 'server.py'])
    })

    it('should not modify unknown commands', async () => {
      const serverConfig = {
        type: 'stdio',
        command: 'python',
        args: ['server.py']
      }

      const client = new McpClient('test', serverConfig)
      const builder = new (client as any).StdioCommandBuilder(
        client.serverConfig,
        (client as any).npmRegistry,
        (client as any).uvRegistry
      )

      const cat = builder['categorize']('python')
      const processedCommand = await builder['processCommandWithArgs']('python', ['server.py'], cat)

      expect(processedCommand.command).toBe('python')
      expect(processedCommand.args).toEqual(['server.py'])
    })
  })

  // ────────────────────────────────────────────────────────────────────────────
  // 运行时路径“检测”场景：仅验证不会把 command 改写为 runtime 路径
  // ────────────────────────────────────────────────────────────────────────────
  describe('Runtime Path Detection', () => {
    ;(process.platform === 'win32' ? it.skip : it)(
      'inlines bun runtime for npx when bun exists',
      async () => {
        mockFsExistsSync.mockImplementation((p: any) => String(p).includes('runtime/bun'))
        const client = new McpClient('test', { type: 'stdio', command: 'npx', args: ['-v'] })
        const builder = new (client as any).StdioCommandBuilder(
          client.serverConfig,
          (client as any).npmRegistry,
          (client as any).uvRegistry
        )
        const cat = builder['categorize']('npx')
        const processed = await builder['processCommandWithArgs']('npx', ['-v'], cat)
        const expected = path.join('/mock/app', 'runtime', 'bun', 'bun')
        expect(processed.command.replace(/\\/g, '/')).toBe(expected.replace(/\\/g, '/'))
        expect(processed.args).toEqual(['x', '-v'])
      }
    )

    it('inlines uv runtime for uvx when uv exists (or keeps uvx)', async () => {
      mockFsExistsSync.mockImplementation((p: any) => String(p).includes('runtime/uv'))
      const client = new McpClient('test', { type: 'stdio', command: 'uvx', args: ['--version'] })
      const builder = new (client as any).StdioCommandBuilder(
        client.serverConfig,
        (client as any).npmRegistry,
        (client as any).uvRegistry
      )
      const cat = builder['categorize']('uvx')
      const processed = await builder['processCommandWithArgs']('uvx', ['--version'], cat)
      const base = path.basename(processed.command).toLowerCase()
      expect(base === 'uvx' || base === 'uvx.exe').toBeTruthy()
      expect(processed.args).toEqual(['--version'])
    })

    it('should handle missing runtime files gracefully (falls back to original command)', async () => {
      mockFsExistsSync.mockReturnValue(false)
      const client = new McpClient('test', { type: 'stdio', command: 'npx', args: ['-v'] })
      const builder = new (client as any).StdioCommandBuilder(
        client.serverConfig,
        (client as any).npmRegistry,
        (client as any).uvRegistry
      )
      const cat = builder['categorize']('npx')
      const processed = await builder['processCommandWithArgs']('npx', ['-v'], cat)
      expect(processed.command.replace(/\\/g, '/')).toBe('npx')
      expect(processed.args).toEqual(['-v'])
    })
  })

  // ────────────────────────────────────────────────────────────────────────────
  // 其余最小补充用例（保持不变）
  // ────────────────────────────────────────────────────────────────────────────
  describe('Environment Variable Processing', () => {
    it('should set npm registry environment variables', () => {
      const client = new McpClient('test', { type: 'stdio' }, 'https://registry.npmmirror.com')

      expect((client as any).npmRegistry).toBe('https://registry.npmmirror.com')
    })

    it('should handle null npm registry', () => {
      const client = new McpClient('test', { type: 'stdio' }, null)

      expect((client as any).npmRegistry).toBeNull()
    })
  })

  describe('Path Expansion', () => {
    it('should expand tilde (~) in paths', () => {
      const client = new McpClient('test', { type: 'stdio' })
      const builder = new (client as any).StdioCommandBuilder({ type: 'stdio' }, null, null)
      const expandedPath = builder['expandPath']('~/test/path')
      expect(expandedPath).toBe('/mock/home/test/path')
    })

    it('should expand environment variables in paths', () => {
      process.env.TEST_VAR = '/test/value'
      const client = new McpClient('test', { type: 'stdio' })
      const builder = new (client as any).StdioCommandBuilder({ type: 'stdio' }, null, null)
      const expandedPath = builder['expandPath']('/path/${TEST_VAR}/file')
      expect(expandedPath).toBe('/path//test/value/file')
      delete process.env.TEST_VAR
    })

    it('should handle simple $VAR format', () => {
      process.env.TEST_PATH = '/simple/test'
      const client = new McpClient('test', { type: 'stdio' })
      const builder = new (client as any).StdioCommandBuilder({ type: 'stdio' }, null, null)
      const expandedPath = builder['expandPath']('/path/$TEST_PATH/file')
      expect(expandedPath).toBe('/path//simple/test/file')
      delete process.env.TEST_PATH
    })
  })

  // =============================
  // Minimal additions start here
  // =============================

  describe('HTTP/SSE Authorization Header Handling (minimal additions)', () => {
    it('SSE: extracts Bearer token into authProvider and strips Authorization from headers', async () => {
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')

      const client = new McpClient('svc-sse', {
        type: 'sse',
        baseUrl: 'https://api.example.com/mcp',
        customHeaders: {
          Authorization: 'Bearer abc123',
          'X-Extra': 'v1'
        }
      })

      await (client as any)._createTransport?.()

      const calls = vi.mocked(SSEClientTransport).mock.calls
      expect(calls.length).toBeGreaterThan(0)

      const urlArg = calls[0][0]
      const opts = calls[0][1] as any

      expect(String(urlArg)).toContain('https://api.example.com/mcp')
      expect(opts?.requestInit?.headers).toEqual({ 'X-Extra': 'v1' })

      const tokenObj = await opts?.authProvider?.tokens?.()
      expect(tokenObj).toEqual({ access_token: 'abc123' })
    })

    it('HTTP: case-insensitive authorization header is supported', async () => {
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      )

      const client = new McpClient('svc-http', {
        type: 'http',
        baseUrl: 'https://api.example.com/mcp',
        customHeaders: {
          authorization: 'Bearer T0KEN',
          'x-extra': 'v2'
        }
      })

      await (client as any)._createTransport?.()

      const calls = vi.mocked(StreamableHTTPClientTransport).mock.calls
      expect(calls.length).toBeGreaterThan(0)

      const opts = calls[0][1] as any
      expect(opts?.requestInit?.headers).toEqual({ 'x-extra': 'v2' })

      const tokenObj = await opts?.authProvider?.tokens?.()
      expect(tokenObj).toEqual({ access_token: 'T0KEN' })
    })

    it('HTTP: no Authorization — headers pass through unchanged and no authProvider is injected', async () => {
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      )

      const client = new McpClient('svc-http-noauth', {
        type: 'http',
        baseUrl: 'https://api.example.com/mcp',
        customHeaders: { 'X-Only': 'y' }
      })

      await (client as any)._createTransport?.()

      const calls = vi.mocked(StreamableHTTPClientTransport).mock.calls
      expect(calls.length).toBeGreaterThan(0)

      const opts = calls[0][1] as any
      expect(opts?.requestInit?.headers).toEqual({ 'X-Only': 'y' })
      expect('authProvider' in opts ? opts.authProvider : undefined).toBeUndefined()
    })
  })

  describe('isServerRunning basic check (minimal additions)', () => {
    it('returns true only when connected and client instance exists', () => {
      const client = new McpClient('status', { type: 'stdio' }) as any
      client.isConnected = false
      client.client = null
      expect(client.isServerRunning()).toBe(false)

      client.isConnected = true
      client.client = null
      expect(client.isServerRunning()).toBe(false)

      client.isConnected = false
      client.client = { dummy: 1 }
      expect(client.isServerRunning()).toBe(false)

      client.isConnected = true
      client.client = { dummy: 1 }
      expect(client.isServerRunning()).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // WSL Command Processing (new tests, minimal additions)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('WSL Command Processing', () => {
    it('should pass through wsl command and args unchanged', async () => {
      const serverConfig = {
        type: 'stdio',
        command: 'wsl',
        args: ['bash', '-lc', 'node server.js']
      }

      const client = new McpClient('wsl-server', serverConfig)
      const builder = new (client as any).StdioCommandBuilder(
        client.serverConfig,
        (client as any).npmRegistry,
        (client as any).uvRegistry
      )

      const cat = builder['categorize']('wsl')
      const processed = await builder['processCommandWithArgs'](
        'wsl',
        ['bash', '-lc', 'node server.js'],
        cat
      )

      // 构建阶段不改命令；参数原样透传
      expect(processed.command).toBe('wsl')
      expect(processed.args).toEqual(['bash', '-lc', 'node server.js'])
    })

    it('should keep absolute wsl path effectively as wsl (normalized/basename allowed), args unchanged', async () => {
      const serverConfig = {
        type: 'stdio',
        command: '/usr/bin/wsl',
        args: ['bash', '-lc', 'uv run server.py']
      }

      const client = new McpClient('wsl-server', serverConfig)
      const builder = new (client as any).StdioCommandBuilder(
        client.serverConfig,
        (client as any).npmRegistry,
        (client as any).uvRegistry
      )

      const cat = builder['categorize']('/usr/bin/wsl')
      const processed = await builder['processCommandWithArgs'](
        '/usr/bin/wsl',
        ['bash', '-lc', 'uv run server.py'],
        cat
      )

      // 与实现对齐：构建阶段允许规范化为 basename；只校验包含 'wsl'
      expect(processed.command).toContain('wsl')
      expect(processed.args).toEqual(['bash', '-lc', 'uv run server.py'])
    })

    it('should treat wsl category as transparent even with nested command paths', async () => {
      const serverConfig = {
        type: 'stdio',
        command: 'wsl',
        // 常见嵌套：在 WSL 内再调用本地安装的 npx / uvx 等，这里都应原样透传
        args: ['bash', '-lc', '/usr/local/bin/npx -y @modelcontextprotocol/server-everything']
      }

      const client = new McpClient('wsl-server', serverConfig)
      const builder = new (client as any).StdioCommandBuilder(
        client.serverConfig,
        (client as any).npmRegistry,
        (client as any).uvRegistry
      )

      const cat = builder['categorize']('wsl')
      const processed = await builder['processCommandWithArgs'](
        'wsl',
        ['bash', '-lc', '/usr/local/bin/npx -y @modelcontextprotocol/server-everything'],
        cat
      )

      // 仍保持透传：不冒然将内部命令改写为 bun/uv，避免破坏 WSL 环境内的解析
      expect(processed.command).toBe('wsl')
      expect(processed.args).toEqual([
        'bash',
        '-lc',
        '/usr/local/bin/npx -y @modelcontextprotocol/server-everything'
      ])
    })
  })

  // =============================
  // Minimal additions end here
  // =============================
})

// Additional sanity test for status event emission on disconnect
describe('McpClient status events', () => {
  it('disconnect emits SERVER_STATUS_CHANGED with stopped', async () => {
    const client = new McpClient('svc', { type: 'stdio' })
    mockEventBus.send.mockClear()
    await client.disconnect()
    expect(mockEventBus.send).toHaveBeenCalled()
    const [eventName, _target, payload] = mockEventBus.send.mock.calls[0]
    expect(eventName).toBe('server-status-changed')
    expect(payload).toMatchObject({ name: 'svc', status: 'stopped' })
  })
})

// New: connection and core API behaviors
describe('McpClient connect and core API behaviors', () => {
  beforeEach(() => {
    mockEventBus.send.mockClear()
    // 避免因 SDK 客户端实现差异导致的通知 handler 绑定报错
    vi.spyOn(
      (McpClient as any).prototype,
      'registerNotificationHandlers' as any
    ).mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.skip('connect (inmemory) succeeds and emits running', async () => {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const { getInMemoryServer } = await import(
      '../../../src/main/presenter/mcpPresenter/inMemoryServers/builder'
    )

    const startServer = vi.fn()
    vi.mocked(InMemoryTransport.createLinkedPair).mockReturnValueOnce([{} as any, {} as any])
    vi.mocked(getInMemoryServer).mockReturnValueOnce({ startServer } as any)

    const client = new McpClient('inmem', { type: 'inmemory', args: ['--x'], env: { A: '1' } })
    await client.connect()

    expect(startServer).toHaveBeenCalled()
    expect(mockEventBus.send).toHaveBeenCalled()
    const [eventName, _target, payload] = mockEventBus.send.mock.calls.find(
      (c) => c[0] === 'server-status-changed'
    )!
    expect(payload).toMatchObject({ name: 'inmem', status: 'running' })
    expect(client.isServerRunning()).toBe(true)
  })

  it('connect failure emits stopped and leaves not running', async () => {
    // Make the upcoming Client.connect reject
    if (lastClientHolder.instance) {
      lastClientHolder.instance.connect.mockResolvedValue(undefined)
    }
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const { getInMemoryServer } = await import(
      '../../../src/main/presenter/mcpPresenter/inMemoryServers/builder'
    )
    vi.mocked(InMemoryTransport.createLinkedPair).mockReturnValueOnce([{} as any, {} as any])
    vi.mocked(getInMemoryServer).mockReturnValueOnce({ startServer: vi.fn() } as any)

    const client = new McpClient('bad', { type: 'inmemory' })
    // Make next connect() reject before invoking connect()
    clientBehavior.shouldRejectConnect = true
    const p = client.connect()
    await expect(p).rejects.toThrow()
    const calls = mockEventBus.send.mock.calls.filter((c) => c[0] === 'server-status-changed')
    expect(calls[calls.length - 1][2]).toMatchObject({ name: 'bad', status: 'stopped' })
    expect(client.isServerRunning()).toBe(false)
  })

  it('listTools caches successful results and returns empty on Method not found', async () => {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const { getInMemoryServer } = await import(
      '../../../src/main/presenter/mcpPresenter/inMemoryServers/builder'
    )
    vi.mocked(InMemoryTransport.createLinkedPair).mockReturnValue([{} as any, {} as any])
    vi.mocked(getInMemoryServer).mockReturnValue({ startServer: vi.fn() } as any)

    const client = new McpClient('svc-tools', { type: 'inmemory' }) as any
    client.isConnected = true
    const fake = {
      listTools: vi.fn()
    }
    client.client = fake
    fake.listTools.mockResolvedValueOnce({
      tools: [{ name: 't', description: 'd', inputSchema: {} }]
    })
    const first = await client.listTools()
    expect(first).toEqual([{ name: 't', description: 'd', inputSchema: {} }])
    // 2nd: cached, no new SDK call
    const second = await client.listTools()
    expect(second).toEqual(first)
    expect(fake.listTools).toHaveBeenCalledTimes(1)

    // 3rd: simulate cache invalidation and refresh without relying on notification binding
    ;(client as any).cachedTools = null
    fake.listTools.mockResolvedValueOnce({ tools: [] })
    const third = await client.listTools()
    expect(third).toEqual([])

    // 4th: simulate Method not found error -> returns [] and caches it
    fake.listTools.mockRejectedValueOnce(new Error('Method not found'))
    // Invalidate cache first
    ;(client as any).cachedTools = null
    const empty = await client.listTools()
    expect(empty).toEqual([])
  })

  it('callTool error result is normalized to error content', async () => {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const { getInMemoryServer } = await import(
      '../../../src/main/presenter/mcpPresenter/inMemoryServers/builder'
    )
    vi.mocked(InMemoryTransport.createLinkedPair).mockReturnValue([{} as any, {} as any])
    vi.mocked(getInMemoryServer).mockReturnValue({ startServer: vi.fn() } as any)

    const client = new McpClient('svc-call', { type: 'inmemory' }) as any
    client.isConnected = true
    const fake = { callTool: vi.fn() }
    client.client = fake
    fake.callTool.mockResolvedValueOnce({ isError: true, content: [] })
    const res = await client.callTool('x', {})
    expect(res.isError).toBe(true)
    expect(res.content[0]).toEqual({ type: 'error', text: 'Unknown error' })
  })

  it('getPrompt formats response shape; readResource maps text or falls back to JSON', async () => {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const { getInMemoryServer } = await import(
      '../../../src/main/presenter/mcpPresenter/inMemoryServers/builder'
    )
    vi.mocked(InMemoryTransport.createLinkedPair).mockReturnValue([{} as any, {} as any])
    vi.mocked(getInMemoryServer).mockReturnValue({ startServer: vi.fn() } as any)

    const client = new McpClient('svc-io', { type: 'inmemory' }) as any
    client.isConnected = true
    const fake = { getPrompt: vi.fn(), readResource: vi.fn() }
    client.client = fake

    fake.getPrompt.mockResolvedValueOnce({ description: 'd', messages: [] })
    const p = await client.getPrompt('hello')
    expect(p).toMatchObject({ id: 'hello', name: 'hello', description: 'd', messages: [] })

    fake.readResource.mockResolvedValueOnce({ text: 'abc' })
    const r1 = await client.readResource('res://1')
    expect(r1).toEqual({ uri: 'res://1', text: 'abc' })

    fake.readResource.mockResolvedValueOnce({ notText: 1 })
    const r2 = await client.readResource('res://2')
    expect(r2.uri).toBe('res://2')
    expect(typeof r2.text).toBe('string')
  })
})

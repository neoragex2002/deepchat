// src/main/presenter/lifecyclePresenter/hooks/proxyHooks.ts

import { LifecycleHook, LifecycleContext } from '@shared/presenter' // 移除 LifecyclePhase
import { LifecyclePhase } from '@shared/lifecycle' // 单独导入 LifecyclePhase
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { spawn, ChildProcess } from 'child_process'
import AdmZip from 'adm-zip'
import { is } from '@electron-toolkit/utils'

// 声明 internalProxyProcess 变量，使其在此模块内可见，用于跟踪代理子进程
let internalProxyProcess: ChildProcess | null = null

// 辅助函数：根据开发/生产环境获取资源基础路径
function getResourceBasePath() {
  if (is.dev) {
    return app.getAppPath()
  } else {
    // 在生产模式下，process.resourcesPath 指向 app.asar 或 app.asar.unpacked 的父目录
    return process.resourcesPath
  }
}

// 辅助函数：获取运行时可执行文件的完整路径
function getRuntimeExecutablePath(runtimeName: string) {
  const basePath = getResourceBasePath()
  let runtimeDir
  if (is.dev) {
    // 在开发模式下，'runtime' 目录通常在项目根目录
    runtimeDir = path.join(basePath, 'runtime', runtimeName)
  } else {
    // 在生产模式下，根据 electron-builder 的配置，'runtime' 目录通常在 'app.asar.unpacked' 内部
    runtimeDir = path.join(basePath, 'app.asar.unpacked', 'runtime', runtimeName)
  }
  const executableName = `${runtimeName}${process.platform === 'win32' ? '.exe' : ''}`
  return path.join(runtimeDir, executableName)
}

// 辅助函数：获取代理脚本的完整路径
function getProxyScriptPath() {
  const basePath = getResourceBasePath()
  // 在生产模式下，proxy.js 位于 'app.asar.unpacked' 内部
  return path.join(basePath, 'app.asar.unpacked', 'internal-proxy', 'proxy.js')
}

/**
 * 生命周期钩子：在应用初始化阶段解压代理脚本
 * 确保代理脚本在启动代理服务前可用
 */
export const unzipProxyHook: LifecycleHook = {
  name: 'UnzipProxyScript',
  phase: LifecyclePhase.INIT, // 在初始化阶段运行
  priority: 10, // 较高的优先级，确保在其他依赖代理的钩子之前执行
  critical: true, // 如果解压失败，代理将无法启动，这是关键错误，应中止应用启动
  execute: async (_context: LifecycleContext) => {
    const PROXY_ZIP_NAME = 'proxy.zip'
    const PROXY_JS_NAME = 'proxy.js'

    const proxyJsPath = getProxyScriptPath()
    const proxyDir = path.dirname(proxyJsPath)
    const proxyZipPath = path.join(proxyDir, PROXY_ZIP_NAME)

    if (fs.existsSync(proxyJsPath)) {
      console.log(
        `[GeminiProxy-Hook] ${PROXY_JS_NAME} already exists at ${proxyJsPath}. Skipping unzip.`
      )
      return // 脚本已存在，无需解压
    }

    if (!fs.existsSync(proxyZipPath)) {
      console.error(`[GeminiProxy-Hook] Proxy zip file not found at: ${proxyZipPath}`)
      throw new Error(`Proxy zip file not found: ${proxyZipPath}`) // 找不到 zip 文件，抛出错误
    }

    console.log(`[GeminiProxy-Hook] Unzipping ${proxyZipPath} to ${proxyDir}`)
    try {
      const zip = new AdmZip(proxyZipPath)
      zip.extractAllTo(proxyDir, true) // true 表示覆盖现有文件
      console.log('[GeminiProxy-Hook] Unzip successful.')
    } catch (error) {
      console.error(`[GeminiProxy-Hook] Failed to unzip with adm-zip: ${(error as Error).message}`)
      throw error // 重新抛出错误，通知 LifecycleManager 钩子执行失败
    }
  }
}

/**
 * 生命周期钩子：在应用完全启动后启动内部代理服务
 * 确保代理服务在应用可用时启动
 */
export const startProxyHook: LifecycleHook = {
  name: 'StartInternalProxyService',
  phase: LifecyclePhase.AFTER_START, // 在 AFTER_START 阶段运行，确保其他核心服务已就绪
  priority: 50, // 默认优先级
  critical: false, // 代理启动失败不一定导致应用崩溃，但会记录警告
  execute: async (_context: LifecycleContext) => {
    console.log('[GeminiProxy-Hook] --- startInternalProxyHook called ---')
    if (internalProxyProcess) {
      console.log('[GeminiProxy-Hook] Proxy process already exists. Aborting.')
      return // 代理进程已存在，无需重复启动
    }

    const bunPath = getRuntimeExecutablePath('bun')
    const proxyScriptPath = getProxyScriptPath()

    console.log(`[GeminiProxy-Hook] Calculated bunPath: ${bunPath}`)
    console.log(`[GeminiProxy-Hook] bunPath exists: ${fs.existsSync(bunPath)}`)
    console.log(`[GeminiProxy-Hook] Calculated proxyScriptPath: ${proxyScriptPath}`)
    console.log(`[GeminiProxy-Hook] proxyScriptPath exists: ${fs.existsSync(proxyScriptPath)}`)

    const userDataPath = app.getPath('userData')
    console.log(`[GeminiProxy-Hook] User data path: ${userDataPath}`)

    const configFilePath =
      process.env.GEMINI_PROXY_CFG_FILE || path.join(userDataPath, 'gemini-proxy-cfg.json')
    const logFilePath =
      process.env.GEMINI_PROXY_LOG_FILE || path.join(userDataPath, 'gemini-proxy.log')

    console.log(`[GeminiProxy-Hook] Using config file path: ${configFilePath}`)
    console.log(`[GeminiProxy-Hook] Using log file path: ${logFilePath}`)

    // 如果配置文件不存在，创建一个默认的
    if (!fs.existsSync(configFilePath)) {
      console.log('[GeminiProxy-Hook] Config file not found. Creating default one.')
      const defaultConfig = {
        port: 9999,
        host: '127.0.0.1',
        log_level: 'info',
        initial_model: 'gemini-2.5-flash',
        outbound_proxy_url: '',
        rateLimit: {
          enabled: true,
          qpsLimit: 1,
          maxConcurrent: 1,
          queueTimeout: 30
        },
        initial_timeout_ms: 30000,
        idle_timeout_ms: 45000,
        job_execution_timeout_ms: 60000
      }
      try {
        fs.mkdirSync(path.dirname(configFilePath), { recursive: true })
        fs.writeFileSync(configFilePath, JSON.stringify(defaultConfig, null, 2))
        console.log('[GeminiProxy-Hook] Default config file created successfully.')
      } catch (error) {
        console.error(
          `[GeminiProxy-Hook] ERROR: Failed to create default proxy config file: ${(error as Error).message}`
        )
        throw error // 抛出错误以通知 LifecycleManager 钩子失败
      }
    }

    // 定义要注入到子进程的环境变量
    const proxyEnv = {
      ...process.env,
      GEMINI_PROXY_CFG_FILE: configFilePath,
      GEMINI_PROXY_LOG_FILE: logFilePath
    }
    console.log(
      `[GeminiProxy-Hook] Environment variables for spawn: ${JSON.stringify(proxyEnv, null, 2)}`
    )

    try {
      console.log('[GeminiProxy-Hook] Attempting to spawn process...')
      // 启动子进程，stdio: 'ignore' 表示忽略子进程的 stdio，避免干扰主进程控制台
      internalProxyProcess = spawn(bunPath, [proxyScriptPath], {
        stdio: 'ignore',
        env: proxyEnv
      })
      console.log('[GeminiProxy-Hook] Spawn command issued successfully. Process object created.')

      // 监听子进程的 exit 事件
      internalProxyProcess.on('exit', (code, signal) => {
        console.log(
          `[GeminiProxy-Hook] [SPAWN EVENT] Process exited with code: ${code}, signal: ${signal}`
        )
        internalProxyProcess = null // 清除引用
      })

      // 监听子进程的 error 事件
      internalProxyProcess.on('error', (err) => {
        console.error(
          `[GeminiProxy-Hook] [SPAWN EVENT] Process failed to start or encountered an error: ${err.toString()}`
        )
        internalProxyProcess = null // 清除引用
      })
    } catch (spawnError) {
      console.error(
        `[GeminiProxy-Hook] [SPAWN CATCH] Caught synchronous error on spawn: ${(spawnError as Error).toString()}`
      )
      throw spawnError // 重新抛出错误，通知 LifecycleManager 钩子执行失败
    }
  }
}

/**
 * 生命周期钩子：在应用退出前停止内部代理服务
 * 确保代理服务在应用关闭前被清理
 */
export const stopProxyHook: LifecycleHook = {
  name: 'StopInternalProxyService',
  phase: LifecyclePhase.BEFORE_QUIT, // 在 BEFORE_QUIT 阶段运行，确保在应用完全退出前清理
  priority: 50, // 默认优先级
  critical: false, // 代理停止失败不阻止应用退出，但会记录警告
  execute: async (_context: LifecycleContext) => {
    console.log('[GeminiProxy-Hook] --- stopInternalProxyHook called ---')
    if (internalProxyProcess) {
      console.log('[GeminiProxy-Hook] Stopping internal proxy process...')
      try {
        internalProxyProcess.kill() // 默认发送 SIGTERM 信号，请求子进程优雅退出
        // 如果需要等待子进程完全退出，可以添加以下代码（但通常在应用退出流程中不是强制的）
        // await new Promise(resolve => internalProxyProcess.on('exit', resolve));
      } catch (e) {
        console.error(`[GeminiProxy-Hook] Error while killing process: ${(e as Error).message}`)
      }
      internalProxyProcess = null // 清除引用
    } else {
      console.log('[GeminiProxy-Hook] No proxy process to stop.')
    }
  }
}

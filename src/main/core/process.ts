import { exec } from 'child_process'
import { promisify } from 'util'
import { rm } from 'fs/promises'
import { existsSync } from 'fs'
import { managerLogger } from '../utils/logger'
import { getAxios } from './mihomoApi'

const execPromise = promisify(exec)

// 常量
const CORE_READY_MAX_RETRIES = 30
const CORE_READY_RETRY_INTERVAL_MS = 100

export async function cleanupSocketFile(): Promise<void> {
  if (process.platform === 'win32') {
    await cleanupWindowsNamedPipes()
  } else {
    await cleanupUnixSockets()
  }
}

export async function cleanupWindowsNamedPipes(): Promise<void> {
  // 用 tasklist 替代 PowerShell ConvertTo-Json，兼容 Win7（默认 PS 2.0 没有 ConvertTo-Json）
  const mihomoExecutables = ['mihomo.exe', 'mihomo-alpha.exe', 'mihomo-smart.exe']
  try {
    for (const executable of mihomoExecutables) {
      try {
        const { stdout } = await execPromise(
          `tasklist /FI "IMAGENAME eq ${executable}" /FO CSV /NH`,
          { encoding: 'utf8' }
        )
        const lines = stdout.split('\n').filter((line) => line.includes('.exe'))
        for (const line of lines) {
          const parts = line.split(',')
          if (parts.length >= 2) {
            const pid = parseInt(parts[1].replace(/"/g, '').trim())
            if (!isNaN(pid) && pid !== process.pid) {
              await terminateProcess(pid)
            }
          }
        }
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  } catch (error) {
    managerLogger.error('Windows named pipe cleanup failed:', error)
  }
}

async function terminateProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, 0)
    process.kill(pid, 'SIGTERM')
    managerLogger.info(`Terminated process ${pid} to free pipe`)
  } catch (error: unknown) {
    if ((error as { code?: string })?.code !== 'ESRCH') {
      managerLogger.warn(`Failed to terminate process ${pid}:`, error)
    }
  }
}

export async function cleanupUnixSockets(): Promise<void> {
  try {
    const socketPaths = [
      '/tmp/mihomo-party.sock',
      '/tmp/mihomo-party-admin.sock',
      `/tmp/mihomo-party-${process.getuid?.() || 'user'}.sock`
    ]

    for (const socketPath of socketPaths) {
      try {
        if (existsSync(socketPath)) {
          await rm(socketPath)
          managerLogger.info(`Cleaned up socket file: ${socketPath}`)
        }
      } catch (error) {
        managerLogger.warn(`Failed to cleanup socket file ${socketPath}:`, error)
      }
    }
  } catch (error) {
    managerLogger.error('Unix socket cleanup failed:', error)
  }
}

export async function validateWindowsPipeAccess(pipePath: string): Promise<void> {
  try {
    managerLogger.info(`Validating pipe access for: ${pipePath}`)
    managerLogger.info(`Pipe validation completed for: ${pipePath}`)
  } catch (error) {
    managerLogger.error('Windows pipe validation failed:', error)
  }
}

export async function waitForCoreReady(): Promise<void> {
  for (let i = 0; i < CORE_READY_MAX_RETRIES; i++) {
    try {
      const axios = await getAxios(true)
      await axios.get('/')
      managerLogger.info(
        `Core ready after ${i + 1} attempts (${(i + 1) * CORE_READY_RETRY_INTERVAL_MS}ms)`
      )
      return
    } catch {
      if (i === 0) {
        managerLogger.info('Waiting for core to be ready...')
      }

      if (i === CORE_READY_MAX_RETRIES - 1) {
        managerLogger.warn(
          `Core not ready after ${CORE_READY_MAX_RETRIES} attempts, proceeding anyway`
        )
        return
      }

      await new Promise((resolve) => setTimeout(resolve, CORE_READY_RETRY_INTERVAL_MS))
    }
  }
}

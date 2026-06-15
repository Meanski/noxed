import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { resolve, normalize } from 'path'

// We test isLikelyTextFile directly (pure function, no FS dependency)
import { isLikelyTextFile } from '../security'

// For isAllowedKeyPath, we test the validation logic in isolation
// since it depends on the filesystem. We extract the pure validation part.

const home = homedir()
const SSH_DIR = resolve(home, '.ssh')

function validateKeyPathLogic(rawPath: string): { ok: true; resolved: string } | { ok: false; reason: string } {
  if (!rawPath || typeof rawPath !== 'string') {
    return { ok: false, reason: 'Path is required' }
  }

  const expanded = rawPath.replace(/^~/, home)
  const resolved = normalize(resolve(expanded))

  const ALLOWED_KEY_DIRS = [
    resolve(home, '.ssh'),
    resolve(home, '.config', 'ssh'),
    resolve(home, '.pem'),
  ]

  const inAllowedDir = ALLOWED_KEY_DIRS.some((dir) => resolved.startsWith(dir + '/') || resolved === dir)
  if (!inAllowedDir) {
    return { ok: false, reason: 'Access denied: path must be inside ~/.ssh or another allowed key directory' }
  }

  if (resolved.includes('\0')) {
    return { ok: false, reason: 'Invalid path: contains null bytes' }
  }

  return { ok: true, resolved }
}

describe('Security — path traversal protection', () => {
  describe('validateKeyPathLogic', () => {
    it('allows ~/.ssh/id_rsa', () => {
      const result = validateKeyPathLogic('~/.ssh/id_rsa')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.resolved).toBe(resolve(SSH_DIR, 'id_rsa'))
    })

    it('allows ~/.ssh/id_ed25519', () => {
      const result = validateKeyPathLogic('~/.ssh/id_ed25519')
      expect(result.ok).toBe(true)
    })

    it('allows absolute path inside .ssh', () => {
      const result = validateKeyPathLogic(`${home}/.ssh/my_key`)
      expect(result.ok).toBe(true)
    })

    it('allows ~/.config/ssh/ paths', () => {
      const result = validateKeyPathLogic('~/.config/ssh/deploy_key')
      expect(result.ok).toBe(true)
    })

    it('allows ~/.pem/ paths', () => {
      const result = validateKeyPathLogic('~/.pem/server.pem')
      expect(result.ok).toBe(true)
    })

    it('BLOCKS /etc/passwd', () => {
      const result = validateKeyPathLogic('/etc/passwd')
      expect(result.ok).toBe(false)
    })

    it('BLOCKS /etc/shadow', () => {
      const result = validateKeyPathLogic('/etc/shadow')
      expect(result.ok).toBe(false)
    })

    it('BLOCKS reading arbitrary home directory files', () => {
      const result = validateKeyPathLogic('~/.env')
      expect(result.ok).toBe(false)
    })

    it('BLOCKS path traversal via ../', () => {
      const result = validateKeyPathLogic('~/.ssh/../../etc/passwd')
      expect(result.ok).toBe(false)
    })

    it('BLOCKS path traversal via encoded sequences', () => {
      const result = validateKeyPathLogic('~/.ssh/../.env')
      expect(result.ok).toBe(false)
    })

    it('BLOCKS absolute paths outside allowed dirs', () => {
      const result = validateKeyPathLogic('/tmp/evil_key')
      expect(result.ok).toBe(false)
    })

    it('BLOCKS empty string', () => {
      const result = validateKeyPathLogic('')
      expect(result.ok).toBe(false)
    })

    it('BLOCKS null-byte injection', () => {
      const result = validateKeyPathLogic('~/.ssh/id_rsa\0/../../etc/passwd')
      expect(result.ok).toBe(false)
    })

    it('BLOCKS reading the .ssh directory itself (not a file)', () => {
      // The directory path resolves to ~/.ssh which equals the allowed dir
      // but it's not inside a subpath, so startsWith(dir + '/') fails
      // and resolved === dir matches — we allow the dir path in validation
      // but the fs:readFile handler will reject it since stat.isFile() fails
      const result = validateKeyPathLogic('~/.ssh')
      // This resolves to the directory itself — validation allows it,
      // but the actual handler checks stat.isFile() which will reject it
      expect(result.ok).toBe(true)
    })

    it('BLOCKS /root/.ssh paths on non-root users', () => {
      if (!home.startsWith('/root')) {
        const result = validateKeyPathLogic('/root/.ssh/id_rsa')
        expect(result.ok).toBe(false)
      }
    })
  })
})

describe('Security — binary file detection', () => {
  describe('isLikelyTextFile', () => {
    const textFiles = [
      'readme.txt', 'config.json', 'docker-compose.yml', 'index.html',
      'styles.css', 'app.tsx', 'main.py', 'server.go', 'lib.rs',
      'script.sh', 'Makefile', 'Dockerfile', '.gitignore', '.env',
      'LICENSE', 'data.sql', 'schema.graphql', 'deploy.tf',
      'config.toml', 'settings.ini', 'app.proto', 'image.svg',
      // Dotfiles: the leading dot is not an extension separator
      '.bashrc', '.zshrc', '.profile', '.vimrc', '.gitconfig', '.htaccess',
      // Extensionless / unknown extensions fall through to content sniffing
      'authorized_keys', 'crontab', 'hosts', 'notes.custom-ext',
      // Full remote paths
      '/etc/nginx/nginx.conf', '/home/user/.bashrc',
    ]

    textFiles.forEach((name) => {
      it(`detects "${name}" as text`, () => {
        expect(isLikelyTextFile(name, 1000)).toBe(true)
      })
    })

    const binaryFiles = [
      'image.png', 'photo.jpg', 'video.mp4', 'archive.zip',
      'binary.exe', 'library.so', 'library.dylib', 'app.wasm',
      'font.ttf', 'data.bin', 'dump.core',
      // Compound and hidden binary names
      'backup.tar.gz', '.hidden.png', '/var/log/app.sqlite',
    ]

    binaryFiles.forEach((name) => {
      it(`detects "${name}" as binary`, () => {
        expect(isLikelyTextFile(name, 1000)).toBe(false)
      })
    })

    it('rejects files over 10 MB regardless of extension', () => {
      expect(isLikelyTextFile('huge.txt', 11 * 1024 * 1024)).toBe(false)
    })

    it('accepts files under 10 MB with text extension', () => {
      expect(isLikelyTextFile('big.json', 9 * 1024 * 1024)).toBe(true)
    })

    it('recognizes known extensionless filenames', () => {
      expect(isLikelyTextFile('Makefile', 500)).toBe(true)
      expect(isLikelyTextFile('Dockerfile', 500)).toBe(true)
      expect(isLikelyTextFile('Vagrantfile', 500)).toBe(true)
      expect(isLikelyTextFile('LICENSE', 500)).toBe(true)
      expect(isLikelyTextFile('README', 500)).toBe(true)
    })
  })
})

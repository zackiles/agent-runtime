import { TarStream, type TarStreamInput } from '@std/tar/tar-stream'
import { UntarStream } from '@std/tar/untar-stream'
import { join } from '@std/path'

type CompressOptions = {
  exclude?: string[]
}

async function compress(
  dir: string,
  opts?: CompressOptions,
): Promise<Uint8Array> {
  const tmp = await Deno.makeTempFile({ suffix: '.tar.gz' })
  try {
    const file = await Deno.open(tmp, { write: true, truncate: true })
    const entries = streamDir(dir, '', opts?.exclude)
    await entries
      .pipeThrough(new TarStream())
      .pipeThrough(new CompressionStream('gzip'))
      .pipeTo(file.writable)
    return await Deno.readFile(tmp)
  } finally {
    await Deno.remove(tmp).catch(() => {})
  }
}

function streamDir(
  base: string,
  prefix: string,
  exclude?: string[],
): ReadableStream<TarStreamInput> {
  return ReadableStream.from(walkDir(base, prefix, exclude))
}

async function* walkDir(
  base: string,
  prefix: string,
  exclude?: string[],
): AsyncGenerator<TarStreamInput> {
  for await (const entry of Deno.readDir(base)) {
    if (exclude?.includes(entry.name)) continue
    const fullPath = join(base, entry.name)
    const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name

    if (entry.isDirectory) {
      yield* walkDir(fullPath, archivePath, exclude)
    } else if (entry.isFile) {
      const stat = await Deno.stat(fullPath)
      const file = await Deno.open(fullPath, { read: true })
      yield {
        type: 'file',
        path: archivePath,
        size: stat.size,
        readable: file.readable,
      }
    }
  }
}

async function extract(
  archive: Uint8Array,
  dest: string,
): Promise<void> {
  const readable = ReadableStream.from([archive])
    .pipeThrough(
      new DecompressionStream('gzip') as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >,
    )
    .pipeThrough(new UntarStream())

  for await (const entry of readable) {
    const path = join(dest, entry.path)
    if (entry.header.typeflag === 'directory') {
      await Deno.mkdir(path, { recursive: true })
    } else {
      const dir = path.substring(0, path.lastIndexOf('/'))
      await Deno.mkdir(dir, { recursive: true })
      const file = await Deno.open(path, {
        write: true,
        create: true,
        truncate: true,
      })
      await entry.readable?.pipeTo(file.writable)
    }
  }
}

export { compress, extract }

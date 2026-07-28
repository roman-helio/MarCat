import { initTRPC } from '@trpc/server'
import type { Context } from './context'

// No data transformer for now: all domain fields are plain JSON
// (text/number/boolean ISO strings), so the default serializer is enough and
// avoids transformer-version mismatches with the electron-trpc link.
const t = initTRPC.context<Context>().create()

export const router = t.router
export const middleware = t.middleware

const mutationTails = new WeakMap<object, Promise<void>>()

async function serializeMutation<T>(key: object, operation: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => gate)
  mutationTails.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (mutationTails.get(key) === tail) mutationTails.delete(key)
  }
}

const workspaceSync = t.middleware(async ({ ctx, type, next }) => {
  const run = async () => {
    await ctx.workspace?.beforeRequest()
    const result = await next()
    if (type === 'mutation') await ctx.workspace?.afterMutation()
    return result
  }
  return type === 'mutation' ? serializeMutation(ctx.db as object, run) : run()
})

export const publicProcedure = t.procedure.use(workspaceSync)

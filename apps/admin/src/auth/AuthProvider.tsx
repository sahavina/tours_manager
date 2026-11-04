import type { Session } from '@supabase/supabase-js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { readLocal, writeLocal } from '../lib/use-url-state'
import { rpc, supabase } from '../lib/supabase'

export type OrgContext = {
  organization_id: string
  name: string
  default_timezone: string
  default_currency: string
  role_key: string
  role_name: string
  permissions: string[]
}

type AuthValue = {
  session: Session | null
  ready: boolean
  orgs: OrgContext[]
  org: OrgContext | null
  orgId: string
  orgsLoading: boolean
  orgsError: boolean
  can: (permission: string) => boolean
  switchOrg: (id: string) => void
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [selected, setSelected] = useState<string | null>(() => readLocal<string | null>('tourhub.org', null))
  const qc = useQueryClient()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (!s) qc.clear()
    })
    return () => data.subscription.unsubscribe()
  }, [qc])

  const orgsQuery = useQuery({
    queryKey: ['org-context', session?.user.id],
    enabled: Boolean(session),
    queryFn: () => rpc<OrgContext[]>('my_org_context'),
    staleTime: 60_000,
  })

  const orgs = useMemo(() => orgsQuery.data ?? [], [orgsQuery.data])
  const org = orgs.find((o) => o.organization_id === selected) ?? orgs[0] ?? null

  const can = useCallback((permission: string) => Boolean(org?.permissions.includes(permission)), [org])

  const switchOrg = useCallback(
    (id: string) => {
      writeLocal('tourhub.org', id)
      setSelected(id)
      // Dữ liệu doanh nghiệp cũ không được còn trong cache khi đổi doanh nghiệp.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'org-context' })
    },
    [qc],
  )

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  const value = useMemo<AuthValue>(
    () => ({
      session,
      ready,
      orgs,
      org,
      orgId: org?.organization_id ?? '',
      orgsLoading: orgsQuery.isLoading,
      orgsError: orgsQuery.isError,
      can,
      switchOrg,
      signOut,
    }),
    [session, ready, orgs, org, orgsQuery.isLoading, orgsQuery.isError, can, switchOrg, signOut],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth phải nằm trong AuthProvider')
  return v
}

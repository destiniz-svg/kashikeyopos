/** The CMS sign-in screen. */
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { currentActor } from '@/lib/http/request'
import { LoginForm } from '@/components/admin/LoginForm'
import { config } from '@/lib/config'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Sign in' }

export default async function LoginPage() {
  if (await currentActor()) redirect('/admin')
  return <LoginForm ownerConfigured={!!config.auth.ownerEmail} />
}

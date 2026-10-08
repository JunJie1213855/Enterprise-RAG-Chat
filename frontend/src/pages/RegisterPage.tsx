import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Bot, Loader2 } from 'lucide-react'
import { authApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'

export default function RegisterPage() {
  const navigate = useNavigate()
  const { setUser, setTokens } = useAuthStore()
  const [form, setForm] = useState({
    email: '', username: '', password: '',
    full_name: '', organization_name: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await authApi.register(form)
      const { data } = await authApi.login(form.email, form.password)
      setTokens(data.access_token, data.refresh_token)
      const meRes = await authApi.me()
      setUser(meRes.data)
      navigate('/chat')
    } catch (err: any) {
      const detail = err.response?.data?.detail
      setError(Array.isArray(detail) ? detail[0]?.msg : (detail || 'Registration failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md animate-slide-up">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-12 h-12 bg-brand-600 rounded-2xl flex items-center justify-center shadow-lg shadow-brand-900/40">
            <Bot className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">EnterprisAI</h1>
            <p className="text-xs text-gray-500">Powered by RAG</p>
          </div>
        </div>

        <div className="glass-card p-8">
          <h2 className="text-2xl font-bold text-white mb-1">Create account</h2>
          <p className="text-gray-400 text-sm mb-6">Start your free workspace</p>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Username *</label>
                <input className="input-field" placeholder="johndoe" value={form.username} onChange={set('username')} required />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Full Name</label>
                <input className="input-field" placeholder="John Doe" value={form.full_name} onChange={set('full_name')} />
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Email *</label>
              <input type="email" className="input-field" placeholder="you@company.com" value={form.email} onChange={set('email')} required />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Password *</label>
              <input type="password" className="input-field" placeholder="Min 8 chars" value={form.password} onChange={set('password')} required />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Organization (optional)</label>
              <input className="input-field" placeholder="Acme Corp" value={form.organization_name} onChange={set('organization_name')} />
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-red-400 text-sm">
                {error}
              </div>
            )}

            <button type="submit" className="btn-primary w-full flex items-center justify-center gap-2 py-3 !mt-5" disabled={loading}>
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {loading ? 'Creating account...' : 'Create account'}
            </button>
          </form>

          <div className="mt-5 pt-5 border-t border-white/5 text-center">
            <p className="text-sm text-gray-500">
              Already have an account?{' '}
              <Link to="/login" className="text-brand-400 hover:text-brand-300 font-medium">Sign in</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

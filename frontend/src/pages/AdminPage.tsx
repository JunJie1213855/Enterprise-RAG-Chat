import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Users, MessageSquare, Database, ArrowLeft,
  BarChart3, Shield, Loader2, UserX, Crown
} from 'lucide-react'
import { adminApi } from '@/services/api'
import { useAuthStore } from '@/store/authStore'
import type { AdminStats, User } from '@/types'

export default function AdminPage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      adminApi.getStats().then(r => setStats(r.data)),
      adminApi.listUsers().then(r => setUsers(r.data)),
    ]).finally(() => setLoading(false))
  }, [])

  const updateRole = async (userId: string, role: string) => {
    await adminApi.updateUserRole(userId, role)
    setUsers(u => u.map(usr => usr.id === userId ? { ...usr, role: role as any } : usr))
  }

  const deactivate = async (userId: string) => {
    if (!confirm('Deactivate this user?')) return
    await adminApi.deactivateUser(userId)
    setUsers(u => u.map(usr => usr.id === userId ? { ...usr, is_active: false } : usr))
  }

  if (loading) return (
    <div className="flex items-center justify-center h-screen">
      <Loader2 className="w-8 h-8 animate-spin text-brand-400" />
    </div>
  )

  return (
    <div className="min-h-screen p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button onClick={() => navigate('/chat')} className="btn-ghost p-2">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-strong flex items-center gap-2">
            <Shield className="w-6 h-6 text-brand-400" />
            Admin Panel
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">Organization management</p>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Users', value: stats.total_users, icon: Users, color: 'text-blue-400' },
            { label: 'Sessions', value: stats.total_sessions, icon: MessageSquare, color: 'text-green-400' },
            { label: 'Messages', value: stats.total_messages, icon: BarChart3, color: 'text-yellow-400' },
            { label: 'Documents', value: stats.total_documents, icon: Database, color: 'text-purple-400' },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="glass-card p-5">
              <div className="flex items-center gap-3 mb-2">
                <Icon className={`w-5 h-5 ${color}`} />
                <span className="text-sm text-gray-400">{label}</span>
              </div>
              <p className="text-3xl font-bold text-strong">{value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Users Table */}
      <div className="glass-card overflow-hidden">
        <div className="px-6 py-4 border-b border-white/5">
          <h2 className="font-semibold text-strong flex items-center gap-2">
            <Users className="w-4 h-4 text-brand-400" />
            Organization Users ({users.length})
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                {['User', 'Email', 'Role', 'Status', 'Actions'].map(h => (
                  <th key={h} className="text-left px-6 py-3 text-xs text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-white/5 hover:bg-white/2 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-brand-600/30 rounded-full flex items-center justify-center text-xs font-bold text-brand-300">
                        {u.username[0]?.toUpperCase()}
                      </div>
                      <span className="text-sm font-medium text-gray-200">{u.full_name || u.username}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-400">{u.email}</td>
                  <td className="px-6 py-4">
                    {u.id === user?.id ? (
                      <span className="text-xs px-2 py-1 bg-brand-600/20 text-brand-300 rounded-full flex items-center gap-1 w-fit">
                        <Crown className="w-3 h-3" />{u.role}
                      </span>
                    ) : (
                      <select
                        value={u.role}
                        onChange={e => updateRole(u.id, e.target.value)}
                        className="text-xs bg-surface-100 border border-white/10 rounded-lg px-2 py-1 text-gray-300 focus:outline-none"
                      >
                        {['admin', 'member', 'viewer'].map(r => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`text-xs px-2 py-1 rounded-full ${u.is_active ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    {u.id !== user?.id && u.is_active && (
                      <button
                        onClick={() => deactivate(u.id)}
                        className="text-gray-600 hover:text-red-400 transition-colors p-1.5 rounded-lg hover:bg-red-500/10"
                      >
                        <UserX className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

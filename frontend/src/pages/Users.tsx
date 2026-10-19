import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api, UserRow, useLive } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Empty, PageHead, toast } from '../components/ui';
import { timeAgo } from '../format';

export default function UsersPage() {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const { data } = useLive<UserRow[]>('/users', 15000);

  const setRole = useMutation({
    mutationFn: (v: { id: string; role: 'admin' | 'viewer' }) => api.patch(`/users/${v.id}`, { role: v.role }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/users'] }); toast('Role updated'); },
    onError: (e: Error) => { qc.invalidateQueries({ queryKey: ['/users'] }); toast(e.message, 'error'); },
  });
  const remove = useMutation({
    mutationFn: (u: UserRow) => api.del(`/users/${u.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/users'] }); toast('User deleted'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <>
      <PageHead title="Users" desc="Administrators can change anything; viewers can see everything but change nothing. New sign-ups start as viewers." />
      <Card flush>
        {!data?.length ? <Empty>No users.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>User</th><th>Role</th><th>Joined</th><th /></tr></thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id}>
                  <td><div className="strong">{u.name} {u.id === me?.id && <Badge tone="accent">you</Badge>}</div><div className="muted small">{u.email}</div></td>
                  <td>
                    <select className="input" value={u.role} aria-label={`Role for ${u.name}`} onChange={(e) => setRole.mutate({ id: u.id, role: e.target.value as 'admin' | 'viewer' })}>
                      <option value="admin">Administrator</option><option value="viewer">Viewer (read-only)</option>
                    </select>
                  </td>
                  <td className="muted nowrap">{timeAgo(u.createdAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn sm danger" disabled={u.id === me?.id} title={u.id === me?.id ? 'You cannot delete yourself' : undefined}
                      onClick={() => confirm(`Delete ${u.name}'s account?`) && remove.mutate(u)}><Trash2 size={12} />Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

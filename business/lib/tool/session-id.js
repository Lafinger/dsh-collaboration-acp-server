export function sessionIdOf(exec) {
    const agent = exec.agent;
    if (agent === null || typeof agent !== 'object')
        return null;
    const session = agent.session;
    if (session === null || typeof session !== 'object')
        return null;
    const id = session.id;
    return typeof id === 'string' && id !== '' ? id : null;
}

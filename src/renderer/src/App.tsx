import { useState } from 'react'
import './assets/main.css' 
import { Dashboard } from './components/Dashboard'
import { ProjectWorkspace } from './components/ProjectWorkspace'

function App() {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  // 1. PROJECT WORKSPACE
  if (activeProjectId) {
    return (
      <ProjectWorkspace 
        projectId={activeProjectId} 
        onBack={() => setActiveProjectId(null)}
      />
    )
  }

  // 2. DASHBOARD
  return (
    <Dashboard 
      onOpenProject={(id) => setActiveProjectId(id)} 
    />
  )
}

export default App
// src/renderer/src/components/Dashboard.tsx
import { useState, useEffect } from 'react'

interface ProjectSummary {
  id: string
  name: string
  path: string
  progress: number
  lastActive: string
}

interface DashboardProps {
  onOpenProject: (projectId: string) => void
}

export function Dashboard({ onOpenProject }: DashboardProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [newProjectName, setNewProjectName] = useState('')
  const [loading, setLoading] = useState(true)

  // 1. LOAD PROJECTS
  useEffect(() => {
    loadProjects()
  }, [])

  const loadProjects = async () => {
    try {
      // @ts-ignore
      const list = await window.api.getProjects()
      setProjects(list)
    } catch (e) {
      console.error("Failed to load projects", e)
    } finally {
      setLoading(false)
    }
  }

  // 2. CREATE PROJECT
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newProjectName.trim()) return

    try {
      // @ts-ignore
      const newProject = await window.api.createProject(newProjectName)
      setProjects([...projects, newProject]) 
      setNewProjectName('') 
    } catch (e) {
      console.error("Failed to create", e)
    }
  }

  return (
    <div className="app-container">
      
      {/* HEADER section */}
      <div className="dashboard-header">
        <div>
          <h1 className="app-title dashboard-title">Your Projects</h1>
          <p className="dashboard-subtitle">Select a workspace to enter flow state.</p>
        </div>
        
        {/* CREATE FORM */}
        <form onSubmit={handleCreate} className="create-input-group">
          <input
            type="text"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            placeholder="New Project..."
            className="input-field input-new-project"
          />
          <button type="submit" className="btn-create">
            + New
          </button>
        </form>
      </div>

      {/* PROJECT GRID */}
      {loading ? (
        <div className="loading-text">Loading...</div>
      ) : projects.length === 0 ? (
        <div className="input-card empty-state">
          <h3>No projects yet</h3>
          <p className="empty-state-text">Create your first project above to get started.</p>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((project) => (
            <div 
              key={project.id}
              onClick={() => onOpenProject(project.id)}
              className="project-card"
            >
              {/* TOP: Icon & Date */}
              <div className="card-header">
                <div className="card-icon">
                  {project.name.substring(0, 2).toUpperCase()}
                </div>
                <span className="card-date">
                  {new Date(project.lastActive).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              </div>
              
              {/* BOTTOM: Name & Progress */}
              <div>
                <h3 className="card-title">{project.name}</h3>
                
                {/* Mini Progress Bar */}
                <div className="progress-track">
                    <div 
                      className="progress-fill" 
                      style={{ width: `${project.progress}%` }}
                    ></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
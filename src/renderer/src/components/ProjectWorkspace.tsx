// src/renderer/src/components/ProjectWorkspace.tsx
import React, { useState } from "react";
import { DecompositionResult, Subtask } from "src/common/types";

interface WorkspaceProps {
  projectId: string;
  onBack: () => void;
}

export function ProjectWorkspace({ projectId, onBack }: WorkspaceProps): React.JSX.Element {

  // Text in the input box
  const [taskTitle, setTaskTitle] = useState('');

  // AI model
  const [selectedModel, setSelectedModel] = useState('gemini/gemini-3-flash-preview'); 

  // Deadline and depth input
  const [deadline, setDeadline] = useState(new Date().toISOString().split('T')[0]);
  const [depth, setDepth] = useState('Brief');

  // Data returned from Python
  const [result, setResult] = useState<DecompositionResult | null>(null);

  // A loading flag for UX
  const [loading, setLoading] = useState(false);

  // State for subtasks list
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  // Error message
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Decompose using arguments
  const handleDecompose = async (): Promise<void> => {
    if (!taskTitle) return;

    setLoading(true);
    setErrorMessage(null); 
    setResult(null);
    setSubtasks([]);

  try {
      // @ts-ignore
      const data = await window.api.decomposeTask(taskTitle, deadline, depth, selectedModel);
      
      if (data.subtasks && data.subtasks[0].id !== 'error') {
        setResult(data);
        setSubtasks(data.subtasks.map((s: any) => ({ ...s, isCompleted: false })));
      } else {
        setErrorMessage("AI Generation Failed.");
      }
    } catch (error) {
      setErrorMessage("System Error.");
    } finally {
      setLoading(false);
    }
  }
  
  const toggleTask = (id: string) => {
    setSubtasks(prev => prev.map(task => 
      task.id === id ? { ...task, isCompleted: !task.isCompleted } : task
    ));
  }

  return (
      <div className="app-container">
        
        {/* NAVIGATION HEADER */}
        {/* We use CSS classes here instead of inline styles */}
        <div className="nav-header">
            <button onClick={onBack} className="nav-btn">
                ← Back to Dashboard
            </button>
            
            <span className="nav-divider">|</span>
            
            {/* Reuse existing .creator class for the project name style */}
            <span className="creator" style={{ marginBottom: 0 }}>
                {projectId.replace(/_/g, ' ')}
            </span>
        </div>
        
        <h1 className="app-title">Flow State OS</h1>

        {/* INPUT CARD */}
        <div className="input-card">
          
          {/* Row 1: The Task */}
          <div className="form-group">
              <label className="input-label">What do you need to do?</label>
              <input
                className="input-field"
                type="text"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="e.g. Write 2000 word essay"
              />
          </div>

          {/* Row 2: The Settings */}
          <div className="form-grid">
              <div>
                  <label className="input-label">Deadline</label>
                  <input 
                      className="input-field"
                      type="date" 
                      value={deadline}
                      onChange={(e) => setDeadline(e.target.value)}
                  />
              </div>
              <div>
                  <label className="input-label">Depth</label>
                  <select 
                      className="select-field"
                      value={depth}
                      onChange={(e) => setDepth(e.target.value)}
                  >
                      <option value="Brief">Brief (Milestones)</option>
                      <option value="Deep">Deep (Micro-steps)</option>
                  </select>
              </div>
              <div>
                  <label className="input-label">Model</label>
                  <select 
                      className="select-field"
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                  >
                      <option value="gemini/gemini-3-flash-preview">Gemini Flash</option>
                      <option value="gpt-4o">GPT-4o</option>
                  </select>
              </div>
          </div>

          {/* Action Button */}
          <button
            className="btn-primary"
            onClick={handleDecompose}
            disabled={loading}
          >
            {loading ? 'Generating Plan...' : 'Ignite Momentum'}
          </button>
        </div>

        <hr className="divider" /> 

        {/* ERROR MESSAGE */}
        {errorMessage && (
          <div className="error-box">
            {errorMessage}
          </div>
        )}

        {/* RESULTS LIST */}
        {subtasks.length > 0 && (
          <div className="results-section">
            <h3 className="results-title">Plan for: <span className="highlight">{result?.originalTask}</span></h3>
            
            <ul className="results-list">
              {subtasks.map((item) => (
                <li key={item.id} className="result-item">
                  <div className={`task-card border-${item.difficulty || 'medium'} ${item.isCompleted ? 'completed' : ''}`}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                      <input 
                        type="checkbox" 
                        checked={item.isCompleted} 
                        onChange={() => toggleTask(item.id)}
                        className="task-checkbox"
                      />
                      <div>
                        <div className="task-meta">{item.scheduledDate} • {item.timeEstimate} min</div>
                        <strong className={`task-title ${item.isCompleted ? 'strike' : ''}`}>{item.title}</strong>
                      </div>
                    </div>
                    <span className="difficulty-badge">{item.difficulty}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }
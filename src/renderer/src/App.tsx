import { useState } from "react";
import { DecompositionResult } from "src/common/types";

function App(): React.JSX.Element {

  // Text in the input box
  const [taskTitle, setTaskTitle] = useState('');

  // Data returned from Python
  const [result, setResult] = useState<DecompositionResult | null>(null);

  // A loading flag for UX
  const [loading, setLoading] = useState(false);

  const handleDecompose = async (): Promise<void> => {

    // Cannot handle empty tasks
    if (!taskTitle) return;

    setLoading(true)
    try {
      const data = await window.api.decomposeTask(taskTitle);
      setResult(data);
    } catch (error) {
      console.error('Failed to decompose:', error);
    } finally {
      setLoading(false);
    }
  }  

  return (
    <div className="container" style={{ padding: '20px', color: 'white'}}>
      <h1>Momentum Flow Decomposer</h1>

      {/* Input section*/ }
      <div className="input-group">
        <input
          type="text"
          value={taskTitle}

          // As the user types, update the 'taskTitle' state
          onChange={(text) => setTaskTitle(text.target.value)}
          placeholder="Enter a task (e.g. Write Thesis A)"
          style={{ padding: '10px', width: '300px', borderRadius: '4px', border: 'none' }}
        />
        <button
          onClick={handleDecompose}
          disabled={loading}
          style={{ marginLeft: '10px', padding: '10px 20px', cursor: 'pointer'}}
        >
          {loading ? 'Decomposing...' : 'Break it Down'}
        </button>
      </div>

      <hr style={{ margin: '20px 0', opacity: 0.3 }} /> 

      {/* Display Logic */}
      {result && (
        <div className="results">
          <h3>Plan for: {result.originalTask}</h3>
          <ul>
            {/* Loop through the subtasks array from Python */}
            {result.subtasks.map((item) => (
              <li key={item.id} style={{ marginBottom: '15px', listStyle: 'none' }}>
                <div style={{ borderLeft: '3px solid #61dafb', paddingLeft: '10px' }}>
                  <strong style={{ fontSize: '1.1em' }}>{item.title}</strong>
                  <p style={{ margin: '5px 0 0 0', fontSize: '0.9em', color: '#aaa' }}>
                    {item.difficulty}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default App;
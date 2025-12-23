// src/common/types.ts

/**
 * Subtask represents the smallest unit of work.
 */
export interface Subtask {
    id: string;
    title: string; 
    isCompleted: boolean;
    difficulty?: 'easy' | 'medium' | 'hard';
    timeEstimate?: number; // in minutes
}

/**
 * Task is the parent goal that contains many Subtasks.
 */
export interface Task {
    id: string;
    title: string;
    subTaskIds: string[];
}

/**
 * Contract for python script.
 * When the AI is called, this JSON structure is expected.
 */
export interface DecompositionResult {
    originalTask: string;
    subtasks: {
        title: string;
        difficulty: 'easy' | 'medium' | 'hard';
        timeEstimate: number;
    }[];
}
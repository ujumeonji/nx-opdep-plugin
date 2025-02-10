import { useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { format } from 'date-fns'
import { debounce } from 'lodash'
import styles from './app.module.css'

interface Todo {
  id: number
  title: string
  completed: boolean
}

const queryClient = new QueryClient()

function App() {
  const [searchTerm, setSearchTerm] = useState('')
  
  const handleSearch = debounce((value: string) => {
    setSearchTerm(value)
  }, 300)

  const { data: todos, isLoading } = useQuery({
    queryKey: ['todos', searchTerm],
    queryFn: async () => {
      const response = await axios.get<Todo[]>('https://jsonplaceholder.typicode.com/todos')
      return response.data
    }
  })

  return (
    <QueryClientProvider client={queryClient}>
      <div className={styles.app}>
        <h1>Sample App</h1>
        <p>Current time: {format(new Date(), 'yyyy-MM-dd HH:mm:ss')}</p>
        
        <input
          type='text'
          placeholder='Search todos...'
          onChange={e => handleSearch(e.target.value)}
          className={styles.searchInput}
        />

        {isLoading ? (
          <p>Loading...</p>
        ) : (
          <ul className={styles.todoList}>
            {todos?.slice(0, 5).map(todo => (
              <li key={todo.id} className={styles.todoItem}>
                {todo.title}
              </li>
            ))}
          </ul>
        )}
      </div>
    </QueryClientProvider>
  )
}

export default App

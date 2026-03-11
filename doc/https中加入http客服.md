类似于 Nginx 的反向代理配置，可以将 `/webbot/` 路径的请求转发到后端服务器

``` txt
location /webbot/ {
        proxy_pass <http://103.158.36.42:3000/>;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        
        # 关键：禁用缓存，确保请求到达后端
        proxy_cache off;
        proxy_buffering off;
    }
```

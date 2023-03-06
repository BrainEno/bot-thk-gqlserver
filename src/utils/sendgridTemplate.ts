export const preRegisterTemplate = (token: string) => `
  <div 
  style="
  padding:25px;
  background:#F7F7F7;
  ">
    <h3 
    style="background:black;
    color:white;
    width:max-content;
    text-align:center;
    margin:15px auto;
    padding:15px;">
    BOT THK
    </h3>
    <h4 style="text-align:center;">欢迎注册! 请点击下方链接激活您的账号</h4>
    <br/>
    <a 
    style="width:600px;
    height:200px;
    text-decoration:underline;
    text-align:center;
    color:#0061D5;"
    href="${process.env.CLIENT_URL}/auth/account/activate/${token}"
    >
    ${process.env.CLIENT_URL}/auth/account/activate/${token}
    </a>
    <br/>
    <p style="text-align:center;">—— 邮件发送自BTN THK ，独立创作平台 ——</p>
    <p style='font-size:20px;text-decoration:underline;text-align:center;'>https://bot-thk.vercel.app</p>
 </div>
`;

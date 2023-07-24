import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { aws_sagemaker as sagemaker } from 'aws-cdk-lib';
import { aws_secretsmanager as secretsmanager } from 'aws-cdk-lib';
import { aws_opensearchservice as opensearchservice } from 'aws-cdk-lib';
import { aws_apigateway as apigateway} from 'aws-cdk-lib';
import { aws_lambda as lambda} from 'aws-cdk-lib';

export class ChatbotCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ingestImageUri = "293175704869.dkr.ecr.eu-west-1.amazonaws.com/chatbot:ingest";
    const ingestInstanceType = "ml.m4.xlarge";
    const ingestInstanceCount = 1;

    const answerImageUri = "293175704869.dkr.ecr.eu-west-1.amazonaws.com/chatbot:answer";
    const answerInstanceType = "ml.g5.12xlarge";
//     const answerInstanceType = "ml.m4.xlarge";
    const answerInstanceCount = 1;

    // Create an S3 bucket to store chatbot docs
    const modelBucket = new s3.Bucket(this, 'Chatbot-data', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const masterUser = new cdk.CfnParameter(this, 'opensearchUsername', {
      type: 'String',
      description: 'Username for OpenSearch master user',
    });

    const masterPassword = new cdk.CfnParameter(this, 'opensearchPassword', {
      type: 'String',
      description: 'Password for OpenSearch master user',
    });

    const accessPolicy: any = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
             AWS: '*'
        },
        Action: 'es:*',
        Resource: `arn:aws:es:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:domain/*`
        }
    ]
    };

    const cfnDomain = new opensearchservice.CfnDomain(this, 'ChatbotDomain', {
      accessPolicies: accessPolicy,
      advancedSecurityOptions: {
        enabled: true,
        internalUserDatabaseEnabled: true,
        masterUserOptions: {
          masterUserName: masterUser.valueAsString,
          masterUserPassword: masterPassword.valueAsString,
        },
      },
      clusterConfig: {
        instanceCount: 2,
        instanceType: 't3.medium.search',
//         multiAzWithStandbyEnabled: false,
        zoneAwarenessConfig: {
          availabilityZoneCount: 2,
        },
        zoneAwarenessEnabled: true,
      },
      domainEndpointOptions: {
        enforceHttps: true,
      },
//       domainName: 'chatbot-opensearch-domain',
      ebsOptions: {
        ebsEnabled: true,
        iops: 3000,
        throughput: 125,
        volumeSize: 100,
        volumeType: 'gp3',
      },
      encryptionAtRestOptions: {
        enabled: true,
      },
      engineVersion: 'OpenSearch_2.7',
      nodeToNodeEncryptionOptions: {
        enabled: true,
      },
    });

    const cfnSecret = new secretsmanager.CfnSecret(this, 'opensearchSecret', {
      name: 'opensearch-secrets',
      secretString: JSON.stringify({
        'MASTER_USERNAME': masterUser.valueAsString,
        'MASTER_PASSWORD': masterPassword.valueAsString,
        'OPENSEARCH_DOMAIN_ENDPOINT': cfnDomain.attrDomainEndpoint
      }),
    });
    cfnSecret.node.addDependency(cfnDomain)

    const ingestDefinitionProperty: sagemaker.CfnModel.ContainerDefinitionProperty = {
      image: ingestImageUri,
      mode: 'SingleModel',
    };

    const answerDefinitionProperty: sagemaker.CfnModel.ContainerDefinitionProperty = {
      image: answerImageUri,
      mode: 'SingleModel',
    };

//     const vpcID = "vpc-0c57816d11f4c8d3a"
//     const sagemakerVpc = ec2.Vpc.fromLookup(this, 'external-vpc', {
//       vpcId: vpcID,
//     });
//
//     const vpcSubnets = sagemakerVpc.selectSubnets({
//         subnetType: ec2.SubnetType.PUBLIC
//     });
//
//     const sagemakerSecurityGroup = new ec2.SecurityGroup(this, 'SG', {
//         vpc: sagemakerVpc,
//     });

//     const vpcConfigProperty: sagemaker.CfnModel.VpcConfigProperty = {
//         securityGroupIds: [sagemakerSecurityGroup.securityGroupId],
//          subnets: vpcSubnets.subnetIds,
//     }

    const sagemakerRole = new iam.Role(this, 'sagemakerRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description: 'Model deployment role',
      inlinePolicies: {
        S3Access: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // Allow the role to read, put, delete, and list objects in your S3 bucket
              actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
              resources: [modelBucket.bucketArn, `${modelBucket.bucketArn}/*`]
            }),
          ],
        }),
        // Allow the role to create and write to CloudWatch Logs for logging
        CloudWatchAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
              resources: ["arn:aws:logs:*:*:*"]
            }),
          ],
        }),
        // Allow the role to pull images from your ECR repository
        ECRAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetAuthorizationToken"
              ],
              resources: [
                "*"
              ]
            }),
          ],
        }),
        // Allow the role to create SageMaker resources
        SageMakerAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                "sagemaker:CreateModel",
                "sagemaker:CreateEndpoint",
                "sagemaker:CreateEndpointConfig"
              ],
              resources: ['*']
            }),
          ],
        }),
//         Ec2Access: new iam.PolicyDocument({
//             statements: [
//                 new iam.PolicyStatement({
//                     actions: [
//                     "ec2:DescribeSubnets",
//                     "ec2:DescribeSecurityGroups",
//                     "ec2:DescribeNetworkInterfaces",
//                     "ec2:CreateNetworkInterfacePermission",
//                     "ec2:DeleteNetworkInterfacePermission",
//                     "ec2:DescribeVpcEndpoints",
//                     "ec2:DescribeVpcs",
//                     "ec2:CreateNetworkInterface",
//                     "ec2:DescribeDhcpOptions",
//                     "ec2:DeleteNetworkInterfacePermission",
//                     "ec2:DeleteNetworkInterface"
//                     ],
//                     resources: ["*"]
//                 })
//             ]
//         })
      }
    })

    const ingestSagemakerModel = new sagemaker.CfnModel(this, 'ingestCfnModel', {
      executionRoleArn: sagemakerRole.roleArn,
      modelName: 'chatbot-ingest',
      primaryContainer: ingestDefinitionProperty,
//       vpcConfig: vpcConfigProperty
    });
    ingestSagemakerModel.node.addDependency(sagemakerRole,cfnSecret)

    const answerSagemakerModel = new sagemaker.CfnModel(this, 'answerCfnModel', {
      executionRoleArn: sagemakerRole.roleArn,
      modelName: 'chatbot-answer',
      primaryContainer: answerDefinitionProperty,
//       vpcConfig: vpcConfigProperty
    });
    answerSagemakerModel.node.addDependency(sagemakerRole,cfnSecret)

    const ingestEndpointConfig = new sagemaker.CfnEndpointConfig(this, 'ingestEndpointConfig', {
      productionVariants: [{
        initialVariantWeight: 1.0,
        modelName: ingestSagemakerModel.attrModelName,
        variantName: 'default',
        initialInstanceCount: ingestInstanceCount,
        instanceType: ingestInstanceType
      }],
    });
    ingestEndpointConfig.node.addDependency(ingestSagemakerModel)

    const ingestEndpoint = new sagemaker.CfnEndpoint(this, 'ingestEndpoint', {
       endpointConfigName: ingestEndpointConfig.attrEndpointConfigName,
    });

    const answerEndpointConfig = new sagemaker.CfnEndpointConfig(this, 'answerEndpointConfig', {
      productionVariants: [{
        initialVariantWeight: 1.0,
        modelName: answerSagemakerModel.attrModelName,
        variantName: 'default',
        initialInstanceCount: answerInstanceCount,
        instanceType: answerInstanceType
      }],
    });
    answerEndpointConfig.node.addDependency(answerSagemakerModel)

    const answerEndpoint = new sagemaker.CfnEndpoint(this, 'answerEndpoint', {
       endpointConfigName: answerEndpointConfig.attrEndpointConfigName,
    });

    const codeDeployment = new s3deploy.BucketDeployment(this, 'DeployScript', {
      sources: [s3deploy.Source.asset('code')],
      destinationBucket: modelBucket,
      destinationKeyPrefix: 'lambda-scripts'
    });
    codeDeployment.node.addDependency(modelBucket);

    const chatbotLambdaRole = new iam.Role(this, 'chatbotLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      roleName: 'chatbotLambdaRole'
    });

    chatbotLambdaRole.addToPolicy(
    new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: [
        'sagemaker:InvokeEndpoint',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents'
    ],
    resources: [
        '*',
        `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`,
        `arn:aws:sagemaker:${cdk.Aws.REGION}:*:endpoint/*`
    ]
    }));

    const ingestLambda = new lambda.Function(this, 'ingestLambda', {
      code: lambda.Code.fromBucket(modelBucket, 'lambda-scripts/ingest-code.zip'),
      runtime: lambda.Runtime.PYTHON_3_10,
      handler: 'index.lambda_handler',
      role: chatbotLambdaRole,
      functionName: 'chatbotIngest',
      timeout: Duration.minutes(1),
      environment: {
        ENDPOINT_NAME : ingestEndpoint.attrEndpointName,
      },
    });
    ingestLambda.node.addDependency(codeDeployment, chatbotLambdaRole);

    const answerLambda = new lambda.Function(this, 'answerLambda', {
      code: lambda.Code.fromBucket(modelBucket, 'lambda-scripts/answer-code.zip'),
      runtime: lambda.Runtime.PYTHON_3_10,
      handler: 'index.lambda_handler',
      role: chatbotLambdaRole,
      functionName: 'chatbotAnswer',
      environment: {
        ENDPOINT_NAME : answerEndpoint.attrEndpointName,
      },
    });
    answerLambda.node.addDependency(codeDeployment, chatbotLambdaRole);

    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'chatbotApi',
    });
    api.node.addDependency(answerLambda, ingestLambda)

    const ingestLambdaApi = new apigateway.LambdaIntegration(ingestLambda, {
      proxy: true, // Enable proxy integration
    });

    const ingestRoute = api.root.addResource('ingest');
    ingestRoute.addCorsPreflight({
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS // this is also the default
    });
    ingestRoute.addMethod('POST', ingestLambdaApi);

    const answerLambdaApi = new apigateway.LambdaIntegration(answerLambda, {
      proxy: true, // Enable proxy integration
    });
    const answerRoute = api.root.addResource('answer');
    answerRoute.addCorsPreflight({
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS // this is also the default
    });
    answerRoute.addMethod('POST', answerLambdaApi);

    const deployment = new apigateway.Deployment(this, 'Deployment', {
      api,
    });
    new apigateway.Stage(this, 'Stage', {
      deployment,
      stageName: 'default',
    });

  }
}


